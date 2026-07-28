import { createHash, randomBytes } from "node:crypto";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { AsyncEntry, findCredentialsAsync } from "@napi-rs/keyring";
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import open from "open";
import type { Config } from "./config.ts";

const KEYRING_SERVICE = "my-context-manager/oauth";
const CALLBACK_PORT = 7332;
const CALLBACK_PATH = "/oauth/callback";
const CALLBACK_TIMEOUT_MS = 5 * 60_000;

interface StoredOAuthState {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
  discovery?: OAuthDiscoveryState;
}

export interface OAuthCredentialStore {
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
}

export class KeyringOAuthCredentialStore implements OAuthCredentialStore {
  async get(account: string): Promise<string | undefined> {
    try {
      const credentials = (await findCredentialsAsync(KEYRING_SERVICE)).filter(
        (credential) => credential.account === account,
      );
      if (credentials.length > 1) {
        throw new Error(`Found multiple credential-store entries for ${account}`);
      }
      return credentials[0]?.password;
    } catch (error) {
      throw keyringError(error);
    }
  }

  async set(account: string, value: string): Promise<void> {
    try {
      await new AsyncEntry(KEYRING_SERVICE, account).setPassword(value);
    } catch (error) {
      throw keyringError(error);
    }
  }
}

export class StoredOAuthProvider implements OAuthClientProvider {
  private authorizationUrl: URL | undefined;
  private readonly account: string;
  private readonly callbackUrl: URL;
  private readonly store: OAuthCredentialStore;
  private data: StoredOAuthState;
  private readonly onAuthorization: ((url: URL) => void | Promise<void>) | undefined;
  private readonly interactive: boolean;
  private forceAuthorization = false;
  private loginBaseline: StoredOAuthState | undefined;

  private constructor(
    account: string,
    callbackUrl: URL,
    store: OAuthCredentialStore,
    data: StoredOAuthState,
    onAuthorization?: (url: URL) => void | Promise<void>,
    interactive = true,
  ) {
    this.account = account;
    this.callbackUrl = callbackUrl;
    this.store = store;
    this.data = data;
    this.onAuthorization = onAuthorization;
    this.interactive = interactive;
  }

  static async create(
    serverId: string,
    serverUrl: string,
    callbackUrl: URL,
    store: OAuthCredentialStore,
    onAuthorization?: (url: URL) => void | Promise<void>,
    interactive = true,
  ): Promise<StoredOAuthProvider> {
    const account = credentialAccount(serverId, serverUrl);
    const serialized = await store.get(account);
    let data: StoredOAuthState = {};

    if (serialized !== undefined) {
      try {
        data = JSON.parse(serialized) as StoredOAuthState;
      } catch (error) {
        throw new Error(`OAuth credentials for ${serverId} are corrupt`, { cause: error });
      }
    }

    return new StoredOAuthProvider(account, callbackUrl, store, data, onAuthorization, interactive);
  }

  get redirectUrl(): URL {
    return this.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "My Context Manager",
      redirect_uris: [this.callbackUrl.toString()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  async state(): Promise<string> {
    if (!this.interactive) {
      throw new OAuthLoginRequiredError();
    }
    if (!this.data.state) {
      this.data.state = randomBytes(32).toString("base64url");
      await this.persist();
    }
    return this.data.state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (!this.interactive && !this.data.clientInformation) {
      throw new OAuthLoginRequiredError();
    }
    return this.data.clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    this.data.clientInformation = clientInformation;
    await this.persist();
  }

  tokens(): OAuthTokens | undefined {
    return this.forceAuthorization ? undefined : this.data.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.data.tokens = tokens;
    this.forceAuthorization = false;
    delete this.data.codeVerifier;
    delete this.data.state;
    await this.persist();
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    assertSecureOAuthUrl(authorizationUrl);
    this.authorizationUrl = authorizationUrl;
    await this.onAuthorization?.(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.data.codeVerifier = codeVerifier;
    await this.persist();
  }

  codeVerifier(): string {
    if (!this.data.codeVerifier) {
      throw new Error("OAuth PKCE verifier is missing; run auth login again");
    }
    return this.data.codeVerifier;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.data.discovery;
  }

  async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> {
    this.data.discovery = discovery;
    await this.persist();
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "all") {
      this.data = {};
    } else if (scope === "client") {
      delete this.data.clientInformation;
    } else if (scope === "tokens") {
      delete this.data.tokens;
    } else if (scope === "verifier") {
      delete this.data.codeVerifier;
      delete this.data.state;
    } else {
      delete this.data.discovery;
    }
    await this.persist();
  }

  expectedState(): string | undefined {
    return this.data.state;
  }

  hasAuthorizationRedirect(): boolean {
    return this.authorizationUrl !== undefined;
  }

  hasGatewayCredentials(): boolean {
    return this.data.tokens !== undefined && this.data.clientInformation !== undefined;
  }

  async beginLogin(): Promise<void> {
    this.loginBaseline = structuredClone(this.data);
    this.forceAuthorization = true;
    this.authorizationUrl = undefined;
    delete this.data.codeVerifier;
    delete this.data.state;
  }

  async commitLogin(): Promise<void> {
    this.forceAuthorization = false;
    this.loginBaseline = undefined;
    delete this.data.codeVerifier;
    delete this.data.state;
    await this.persist();
  }

  abortLogin(): void {
    if (this.loginBaseline) {
      this.data = this.loginBaseline;
    }
    this.loginBaseline = undefined;
    this.forceAuthorization = false;
    this.authorizationUrl = undefined;
  }

  private async persist(): Promise<void> {
    if (this.loginBaseline) {
      return;
    }
    await this.store.set(this.account, JSON.stringify(this.data));
  }
}

export interface OAuthLoginOptions {
  store?: OAuthCredentialStore;
  openAuthorizationUrl?: (url: URL) => void | Promise<void>;
  callbackPort?: number;
  callbackTimeoutMs?: number;
}

export async function loginToOAuthServer(
  config: Config,
  serverId: string,
  options: OAuthLoginOptions = {},
): Promise<void> {
  const serverConfig = config.servers[serverId];
  if (!serverConfig) {
    throw new Error(`Unknown upstream server: ${serverId}`);
  }
  if (serverConfig.transport !== "streamable-http" || serverConfig.auth !== "oauth") {
    throw new Error(`Upstream server ${serverId} is not configured with auth: oauth`);
  }

  const callback = await startCallbackServer(
    options.callbackPort ?? CALLBACK_PORT,
    options.callbackTimeoutMs ?? CALLBACK_TIMEOUT_MS,
  );
  const callbackUrl = new URL(CALLBACK_PATH, callback.baseUrl);
  const store = options.store ?? new KeyringOAuthCredentialStore();
  let provider: StoredOAuthProvider;
  try {
    provider = await StoredOAuthProvider.create(
      serverId,
      serverConfig.url,
      callbackUrl,
      store,
      async (url) => {
        callback.expectState(provider.expectedState());
        console.log(`Open this URL to authorize ${serverId}:\n${url.href}`);
        await (options.openAuthorizationUrl ?? openBrowser)(url);
      },
    );
  } catch (error) {
    await callback.close();
    throw error;
  }

  let completed = false;

  try {
    await provider.beginLogin();
    const serverUrl = new URL(serverConfig.url);
    const fetchFn = createSecureScopedFetch(serverUrl, resolveHeaders(serverConfig.headers));
    const result = await auth(provider, { serverUrl, fetchFn });
    if (result !== "REDIRECT" || !provider.hasAuthorizationRedirect()) {
      throw new Error(`OAuth server ${serverId} did not start browser authorization`);
    }

    const callbackResult = await callback.result;
    const finishResult = await auth(provider, {
      serverUrl,
      authorizationCode: callbackResult.code,
      fetchFn,
    });
    if (finishResult !== "AUTHORIZED") {
      throw new Error(`OAuth server ${serverId} did not accept the authorization code`);
    }

    await provider.commitLogin();
    completed = true;
  } finally {
    try {
      if (!completed) {
        provider.abortLogin();
      }
    } finally {
      await callback.close();
    }
  }
}

export function oauthCallbackUrl(): URL {
  return new URL(`http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`);
}

function credentialAccount(serverId: string, serverUrl: string): string {
  const digest = createHash("sha256").update(serverUrl).digest("hex").slice(0, 24);
  return `${serverId}:${digest}`;
}

interface CallbackResult {
  code: string;
  state: string | undefined;
}

interface CallbackServer {
  baseUrl: URL;
  result: Promise<CallbackResult>;
  expectState(state: string | undefined): void;
  close(): Promise<void>;
}

async function startCallbackServer(port: number, timeoutMs: number): Promise<CallbackServer> {
  let settle: ((result: CallbackResult) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  const result = new Promise<CallbackResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  void result.catch(() => undefined);
  let expectedState: string | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let closePromise: Promise<void> | undefined;

  const server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end("Not found");
      return;
    }

    const oauthError = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? undefined;
    if (!expectedState || state !== expectedState) {
      sendCallbackResponse(response, 400, "Invalid authorization state.");
      return;
    }
    if (oauthError) {
      sendCallbackResponse(response, 400, "Authorization failed. Return to the terminal.");
      fail?.(new Error(`OAuth authorization failed: ${oauthError}`));
    } else if (!code) {
      sendCallbackResponse(response, 400, "Authorization code is missing.");
      fail?.(new Error("OAuth callback did not include an authorization code"));
    } else {
      sendCallbackResponse(response, 200, "Authorization complete. You can close this window.");
      settle?.({ code, state });
    }
  });

  await listen(server, port);
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("OAuth callback server did not receive a TCP address");
  }

  const close = (): Promise<void> => {
    closePromise ??= new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    return closePromise;
  };

  return {
    baseUrl: new URL(`http://127.0.0.1:${address.port}`),
    result,
    expectState: (state) => {
      expectedState = state;
      if (!timeout) {
        timeout = setTimeout(() => {
          fail?.(new Error("Timed out waiting for OAuth authorization"));
          void close().catch((error: unknown) =>
            fail?.(error instanceof Error ? error : new Error(String(error))),
          );
        }, timeoutMs);
        timeout.unref();
      }
    },
    close: async () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      await close();
    },
  };
}

function listen(server: HttpServer, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function sendCallbackResponse(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(message);
}

function resolveHeaders(
  references: Record<string, { fromEnv: string; prefix: string }>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(references).map(([name, reference]) => {
      const value = process.env[reference.fromEnv];
      if (value === undefined) {
        throw new Error(`Required environment variable ${reference.fromEnv} is not set`);
      }
      return [name, `${reference.prefix}${value}`];
    }),
  );
}

async function openBrowser(url: URL): Promise<void> {
  assertSecureOAuthUrl(url);
  await open(url.href, { wait: false });
}

function keyringError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Could not access the operating system credential store: ${message}`, {
    cause: error,
  });
}

export function createSecureScopedFetch(
  serverUrl: URL,
  serverHeaders: Record<string, string>,
): typeof fetch {
  return async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : input);
    assertSecureOAuthUrl(target);
    const headers = new Headers(sameEndpoint(target, serverUrl) ? serverHeaders : undefined);
    for (const [name, value] of new Headers(init?.headers)) {
      headers.set(name, value);
    }

    const response = await fetch(input, { ...init, headers, redirect: "error" });
    assertSecureOAuthUrl(new URL(response.url));
    return response;
  };
}

export class OAuthLoginRequiredError extends Error {
  override name = "OAuthLoginRequiredError";
}

function assertSecureOAuthUrl(url: URL): void {
  if (url.protocol !== "https:" && !isLoopback(url)) {
    throw new Error(`Refusing to send OAuth data over insecure URL ${url.origin}`);
  }
}

function sameEndpoint(left: URL, right: URL): boolean {
  return left.origin === right.origin && left.pathname === right.pathname;
}

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}
