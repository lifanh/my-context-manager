import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { expect, test } from "vite-plus/test";
import { parseConfig } from "../src/config.ts";
import { Gateway } from "../src/gateway.ts";
import {
  loginToOAuthServer,
  type OAuthCredentialStore,
  StoredOAuthProvider,
} from "../src/oauth.ts";

class MemoryCredentialStore implements OAuthCredentialStore {
  readonly values = new Map<string, string>();

  async get(account: string): Promise<string | undefined> {
    return this.values.get(account);
  }

  async set(account: string, value: string): Promise<void> {
    this.values.set(account, value);
  }
}

test("persists OAuth provider state without mixing upstream credentials", async () => {
  const store = new MemoryCredentialStore();
  const callback = new URL("http://127.0.0.1:7332/oauth/callback");
  const first = await StoredOAuthProvider.create(
    "source",
    "https://one.example/mcp",
    callback,
    store,
  );
  const second = await StoredOAuthProvider.create(
    "source",
    "https://two.example/mcp",
    callback,
    store,
  );

  await first.saveTokens({ access_token: "one", token_type: "bearer" });
  await second.saveTokens({ access_token: "two", token_type: "bearer" });

  const restored = await StoredOAuthProvider.create(
    "source",
    "https://one.example/mcp",
    callback,
    store,
  );
  expect(restored.tokens()?.access_token).toBe("one");
  expect(store.values.size).toBe(2);
});

test("keeps working tokens when an interactive login is abandoned", async () => {
  const store = new MemoryCredentialStore();
  const callback = new URL("http://127.0.0.1:7332/oauth/callback");
  const provider = await StoredOAuthProvider.create(
    "source",
    "https://one.example/mcp",
    callback,
    store,
  );
  await provider.saveTokens({
    access_token: "working-token",
    refresh_token: "working-refresh",
    token_type: "bearer",
  });

  await provider.beginLogin();
  expect(provider.tokens()).toBeUndefined();
  await provider.state();
  await provider.saveCodeVerifier("pending-verifier");
  provider.abortLogin();

  expect(provider.tokens()).toMatchObject({
    access_token: "working-token",
    refresh_token: "working-refresh",
  });
  const persisted = JSON.parse([...store.values.values()][0] ?? "{}") as Record<string, unknown>;
  expect(persisted.state).toBeUndefined();
  expect(persisted.codeVerifier).toBeUndefined();
});

test("gateway requests explicit login without starting an OAuth flow", async () => {
  const oauthServer = await startOAuthMcpServer();
  const store = new MemoryCredentialStore();
  const config = parseConfig(`
version: 1
servers:
  remote:
    transport: streamable-http
    url: ${oauthServer.mcpUrl.href}
    auth: oauth
profiles:
  testing:
    tools:
      - server: remote
        tool: remote.echo
`);

  try {
    await expect(Gateway.create(config, { oauthStore: store })).rejects.toThrowError(
      /context-manager auth login remote/,
    );
    expect(store.values.size).toBe(0);
    expect(oauthServer.requestCount()).toBe(0);
  } finally {
    await oauthServer.close();
  }
});

test("logs in with PKCE, restores credentials, and refreshes them", async () => {
  const oauthServer = await startOAuthMcpServer();
  const store = new MemoryCredentialStore();
  process.env.OAUTH_TEST_RESOURCE_HEADER = "resource-only";
  const config = parseConfig(`
version: 1
listen:
  port: 0
servers:
  remote:
    transport: streamable-http
    url: ${oauthServer.mcpUrl.href}
    auth: oauth
    headers:
      X-Resource-Secret:
        fromEnv: OAUTH_TEST_RESOURCE_HEADER
profiles:
  testing:
    tools:
      - server: remote
        tool: remote.echo
`);

  try {
    await loginToOAuthServer(config, "remote", {
      store,
      callbackPort: 0,
      openAuthorizationUrl: async (url) => {
        const response = await fetch(url);
        expect(response.ok).toBe(true);
      },
    });

    expect(oauthServer.authorizationCount()).toBe(1);
    expect(oauthServer.codeVerifierWasValid()).toBe(true);
    expect(oauthServer.oauthEndpointReceivedResourceHeader()).toBe(false);
    const storedAfterLogin = JSON.parse([...store.values.values()][0] ?? "{}") as Record<
      string,
      unknown
    >;
    expect(storedAfterLogin.codeVerifier).toBeUndefined();

    oauthServer.requireRefreshedToken();
    const gateway = await Gateway.create(config, { oauthStore: store });
    try {
      expect(gateway.profileNames()).toEqual(["testing"]);
      expect(oauthServer.refreshCount()).toBe(1);
      expect(oauthServer.mcpEndpointReceivedResourceHeader()).toBe(true);
      expect([...store.values.values()].join(" ")).toContain("access-2");
    } finally {
      await gateway.close();
    }

    oauthServer.rejectCurrentTokenAndRefresh();
    await expect(Gateway.create(config, { oauthStore: store })).rejects.toThrowError(
      /context-manager auth login remote/,
    );
    expect(oauthServer.registrationCount()).toBe(1);
    expect(oauthServer.authorizationCount()).toBe(1);
    expect([...store.values.values()].join(" ")).not.toContain("codeVerifier");
    expect([...store.values.values()].join(" ")).not.toContain('"state"');
  } finally {
    delete process.env.OAUTH_TEST_RESOURCE_HEADER;
    await oauthServer.close();
  }
});

interface OAuthMcpServer {
  mcpUrl: URL;
  requestCount(): number;
  registrationCount(): number;
  authorizationCount(): number;
  refreshCount(): number;
  codeVerifierWasValid(): boolean;
  oauthEndpointReceivedResourceHeader(): boolean;
  mcpEndpointReceivedResourceHeader(): boolean;
  requireRefreshedToken(): void;
  rejectCurrentTokenAndRefresh(): void;
  close(): Promise<void>;
}

async function startOAuthMcpServer(): Promise<OAuthMcpServer> {
  let baseUrl: URL;
  let requestCount = 0;
  let registrationCount = 0;
  let authorizationCount = 0;
  let refreshCount = 0;
  let expectedChallenge: string | undefined;
  let codeVerifierWasValid = false;
  let oauthEndpointReceivedResourceHeader = false;
  let mcpEndpointReceivedResourceHeader = false;
  let requiredToken = "access-1";
  let rejectRefresh = false;

  const server = createServer(async (request, response) => {
    try {
      requestCount += 1;
      const url = new URL(request.url ?? "/", baseUrl);
      if (url.pathname === "/mcp") {
        mcpEndpointReceivedResourceHeader ||=
          request.headers["x-resource-secret"] === "resource-only";
      } else {
        oauthEndpointReceivedResourceHeader ||=
          request.headers["x-resource-secret"] === "resource-only";
      }

      if (url.pathname.includes(".well-known/oauth-protected-resource")) {
        sendJson(response, 200, {
          resource: new URL("/mcp", baseUrl).href,
          authorization_servers: [baseUrl.href],
          scopes_supported: ["tools"],
        });
        return;
      }

      if (url.pathname === "/.well-known/oauth-authorization-server") {
        sendJson(response, 200, {
          issuer: baseUrl.href,
          authorization_endpoint: new URL("/authorize", baseUrl).href,
          token_endpoint: new URL("/token", baseUrl).href,
          registration_endpoint: new URL("/register", baseUrl).href,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        });
        return;
      }

      if (url.pathname === "/register" && request.method === "POST") {
        registrationCount += 1;
        sendJson(response, 201, {
          client_id: "context-manager-test",
          redirect_uris: [(await readJson(request)).redirect_uris].flat(),
          token_endpoint_auth_method: "none",
        });
        return;
      }

      if (url.pathname === "/authorize") {
        authorizationCount += 1;
        expectedChallenge = url.searchParams.get("code_challenge") ?? undefined;
        const redirect = new URL(requiredQuery(url, "redirect_uri"));
        redirect.searchParams.set("code", "authorization-code");
        const state = url.searchParams.get("state");
        if (state) {
          redirect.searchParams.set("state", state);
        }
        response.writeHead(302, { location: redirect.href }).end();
        return;
      }

      if (url.pathname === "/token" && request.method === "POST") {
        const body = new URLSearchParams(await readBody(request));
        if (body.get("grant_type") === "refresh_token") {
          refreshCount += 1;
          if (rejectRefresh) {
            sendJson(response, 400, { error: "invalid_client" });
            return;
          }
          sendJson(response, 200, {
            access_token: "access-2",
            refresh_token: "refresh-1",
            token_type: "bearer",
          });
          return;
        }

        const verifier = requiredForm(body, "code_verifier");
        codeVerifierWasValid =
          createHash("sha256").update(verifier).digest("base64url") === expectedChallenge;
        sendJson(response, 200, {
          access_token: "access-1",
          refresh_token: "refresh-1",
          token_type: "bearer",
        });
        return;
      }

      if (url.pathname === "/mcp") {
        if (request.headers.authorization !== `Bearer ${requiredToken}`) {
          response
            .writeHead(401, {
              "www-authenticate": `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource", baseUrl).href}", scope="tools"`,
            })
            .end();
          return;
        }
        await handleMcp(request, response);
        return;
      }

      response.writeHead(404).end();
    } catch (error) {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    }
  });

  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test OAuth server did not receive an address");
  }
  baseUrl = new URL(`http://127.0.0.1:${address.port}`);

  return {
    mcpUrl: new URL("/mcp", baseUrl),
    requestCount: () => requestCount,
    registrationCount: () => registrationCount,
    authorizationCount: () => authorizationCount,
    refreshCount: () => refreshCount,
    codeVerifierWasValid: () => codeVerifierWasValid,
    oauthEndpointReceivedResourceHeader: () => oauthEndpointReceivedResourceHeader,
    mcpEndpointReceivedResourceHeader: () => mcpEndpointReceivedResourceHeader,
    requireRefreshedToken: () => {
      requiredToken = "access-2";
    },
    rejectCurrentTokenAndRefresh: () => {
      requiredToken = "unavailable-token";
      rejectRefresh = true;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function handleMcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === "DELETE") {
    response.writeHead(200).end();
    return;
  }

  const message = await readJson(request);
  if (message.method === "notifications/initialized") {
    response.writeHead(202).end();
  } else if (message.method === "initialize") {
    sendJson(response, 200, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "oauth-test", version: "1.0.0" },
      },
    });
  } else if (message.method === "tools/list") {
    sendJson(response, 200, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "remote.echo",
            description: "Echo a value",
            inputSchema: { type: "object" },
          },
        ],
      },
    });
  } else {
    response.writeHead(202).end();
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return JSON.parse(await readBody(request)) as Record<string, unknown>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) {
    throw new Error(`Missing query parameter ${name}`);
  }
  return value;
}

function requiredForm(body: URLSearchParams, name: string): string {
  const value = body.get(name);
  if (!value) {
    throw new Error(`Missing form parameter ${name}`);
  }
  return value;
}
