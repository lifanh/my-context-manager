import { randomUUID } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { buildProfileCatalog, type DiscoveredTools } from "./catalog.ts";
import { type Config, type ServerConfig } from "./config.ts";

const IMPLEMENTATION = { name: "my-context-manager", version: "0.1.0" };

interface DownstreamSession {
  profileName: string;
  server: Server;
  transport: StreamableHTTPServerTransport;
}

class UpstreamConnection {
  readonly client = new Client(IMPLEMENTATION, { capabilities: {} });
  readonly id: string;
  tools: ReadonlyMap<string, Tool> = new Map();
  private readonly config: ServerConfig;
  private readonly onToolsChanged: (serverId: string) => Promise<void>;

  constructor(
    id: string,
    config: ServerConfig,
    onToolsChanged: (serverId: string) => Promise<void>,
  ) {
    this.id = id;
    this.config = config;
    this.onToolsChanged = onToolsChanged;
  }

  async connect(): Promise<void> {
    this.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        await this.refreshTools();
        await this.onToolsChanged(this.id);
      } catch (error) {
        console.error(`Could not refresh tools from ${this.id}: ${errorMessage(error)}`);
      }
    });

    if (this.config.transport === "streamable-http") {
      const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
        requestInit: { headers: resolveEnvironmentValues(this.config.headers) },
      });
      await this.client.connect(transport);
    } else {
      const transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args,
        cwd: this.config.cwd,
        env: {
          ...getDefaultEnvironment(),
          ...resolveEnvironmentValues(this.config.environment),
        },
        stderr: "inherit",
      });
      await this.client.connect(transport);
    }

    await this.refreshTools();
  }

  async callTool(
    name: string,
    args: Record<string, unknown> | undefined,
    signal: AbortSignal,
    timeout: number,
  ): Promise<CallToolResult> {
    return this.client.request(
      {
        method: "tools/call",
        params: { name, arguments: args },
      },
      CallToolResultSchema,
      { signal, timeout },
    );
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private async refreshTools(): Promise<void> {
    const tools = new Map<string, Tool>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    do {
      const page = await this.client.listTools(cursor === undefined ? undefined : { cursor });

      for (const tool of page.tools) {
        if (tools.has(tool.name)) {
          throw new Error(`Upstream returned duplicate tool name ${tool.name}`);
        }
        tools.set(tool.name, tool);
      }

      cursor = page.nextCursor;
      if (cursor !== undefined && seenCursors.has(cursor)) {
        throw new Error(`Upstream repeated tools/list cursor ${cursor}`);
      }
      if (cursor !== undefined) {
        seenCursors.add(cursor);
      }
    } while (cursor !== undefined);

    this.tools = tools;
  }
}

export class Gateway {
  private readonly upstreams = new Map<string, UpstreamConnection>();
  private readonly sessions = new Map<string, DownstreamSession>();
  private readonly config: Config;
  private httpServer: HttpServer | undefined;
  private closing = false;

  private constructor(config: Config) {
    this.config = config;
  }

  static async create(config: Config): Promise<Gateway> {
    const gateway = new Gateway(config);

    try {
      await gateway.connectUpstreams();
      gateway.validateCatalogs();
      return gateway;
    } catch (error) {
      await gateway.close();
      throw error;
    }
  }

  async listen(): Promise<URL> {
    if (this.httpServer) {
      throw new Error("Gateway is already listening");
    }

    const server = createHttpServer((request, response) => {
      void this.handleHttpRequest(request, response).catch((error: unknown) => {
        this.handleHttpError(response, error);
      });
    });

    this.httpServer = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.config.listen.port, "127.0.0.1");
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Gateway did not receive a TCP listening address");
    }

    return new URL(`http://127.0.0.1:${address.port}`);
  }

  profileNames(): string[] {
    return Object.keys(this.config.profiles);
  }

  async close(): Promise<void> {
    if (this.closing) {
      return;
    }
    this.closing = true;

    const httpClose = this.httpServer
      ? new Promise<void>((resolve, reject) => {
          this.httpServer?.close((error) => (error ? reject(error) : resolve()));
        })
      : Promise.resolve();

    await Promise.allSettled([...this.sessions.values()].map((session) => session.server.close()));
    this.sessions.clear();
    await httpClose;
    await Promise.allSettled([...this.upstreams.values()].map((upstream) => upstream.close()));
    this.upstreams.clear();
  }

  private async connectUpstreams(): Promise<void> {
    const connections = Object.entries(this.config.servers).map(async ([id, config]) => {
      const connection = new UpstreamConnection(id, config, (serverId) =>
        this.handleUpstreamToolsChanged(serverId),
      );
      this.upstreams.set(id, connection);
      await connection.connect();
    });

    await Promise.all(connections);
  }

  private validateCatalogs(): void {
    const discovered = this.discoveredTools();
    for (const profileName of this.profileNames()) {
      buildProfileCatalog(this.config, profileName, discovered);
    }
  }

  private discoveredTools(): DiscoveredTools {
    return new Map(
      [...this.upstreams.entries()].map(([id, upstream]) => [id, upstream.tools] as const),
    );
  }

  private createDownstreamServer(profileName: string): Server {
    const server = new Server(IMPLEMENTATION, {
      capabilities: { tools: { listChanged: true } },
      instructions: `This endpoint exposes the ${profileName} tool profile.`,
    });

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const catalog = buildProfileCatalog(this.config, profileName, this.discoveredTools(), false);
      return { tools: [...catalog.values()].map((route) => route.descriptor) };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const catalog = buildProfileCatalog(this.config, profileName, this.discoveredTools(), false);
      const route = catalog.get(request.params.name);

      if (!route) {
        return toolError(`Unknown or unavailable tool: ${request.params.name}`);
      }

      const upstream = this.upstreams.get(route.serverId);
      if (!upstream) {
        return toolError(`Upstream server is unavailable: ${route.serverId}`);
      }

      try {
        return await upstream.callTool(
          route.sourceName,
          request.params.arguments,
          extra.signal,
          this.config.listen.toolTimeoutMs,
        );
      } catch (error) {
        if (extra.signal.aborted) {
          throw error;
        }
        return toolError(`Upstream tool failed: ${errorMessage(error)}`);
      }
    });

    return server;
  }

  private async handleUpstreamToolsChanged(serverId: string): Promise<void> {
    const affectedProfiles = new Set(
      Object.entries(this.config.profiles)
        .filter(([, profile]) => profile.tools.some((tool) => tool.server === serverId))
        .map(([profileName]) => profileName),
    );

    const notifications = [...this.sessions.values()]
      .filter((session) => affectedProfiles.has(session.profileName))
      .map((session) => session.server.sendToolListChanged());
    const results = await Promise.allSettled(notifications);

    for (const result of results) {
      if (result.status === "rejected") {
        console.error(`Could not notify downstream client: ${errorMessage(result.reason)}`);
      }
    }
  }

  private async handleHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    this.validateOrigin(request);

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/healthz" && request.method === "GET") {
      sendJson(response, 200, {
        status: "ok",
        profiles: this.profileNames(),
        upstreams: [...this.upstreams.keys()],
      });
      return;
    }

    const match = /^\/mcp\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    const profileName = match?.[1];
    if (!profileName || !this.config.profiles[profileName]) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    const sessionId = singleHeader(request, "mcp-session-id");

    if (request.method === "POST") {
      const body = await readJsonBody(request, this.config.listen.requestBodyLimitBytes);

      if (sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session || session.profileName !== profileName) {
          sendMcpError(response, 404, "Session not found");
          return;
        }

        await session.transport.handleRequest(request, response, body);
        return;
      }

      if (!isInitializeRequest(body)) {
        sendMcpError(response, 400, "Mcp-Session-Id is required");
        return;
      }

      await this.initializeSession(profileName, request, response, body);
      return;
    }

    if (request.method === "GET" || request.method === "DELETE") {
      if (!sessionId) {
        sendMcpError(response, 400, "Mcp-Session-Id is required");
        return;
      }

      const session = this.sessions.get(sessionId);
      if (!session || session.profileName !== profileName) {
        sendMcpError(response, 404, "Session not found");
        return;
      }

      await session.transport.handleRequest(request, response);
      return;
    }

    response.writeHead(405, { allow: "GET, POST, DELETE" });
    response.end();
  }

  private async initializeSession(
    profileName: string,
    request: IncomingMessage,
    response: ServerResponse,
    body: unknown,
  ): Promise<void> {
    const server = this.createDownstreamServer(profileName);
    let transport: StreamableHTTPServerTransport;

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (sessionId) => {
        this.sessions.set(sessionId, { profileName, server, transport });
      },
      onsessionclosed: (sessionId) => {
        this.sessions.delete(sessionId);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        this.sessions.delete(transport.sessionId);
      }
    };
    transport.onerror = (error) => {
      console.error(`Downstream transport failed: ${error.message}`);
    };

    await server.connect(transport);

    try {
      await transport.handleRequest(request, response, body);
    } catch (error) {
      if (!transport.sessionId) {
        await server.close();
      }
      throw error;
    }
  }

  private validateOrigin(request: IncomingMessage): void {
    const origin = request.headers.origin;
    if (origin === undefined) {
      return;
    }

    if (Array.isArray(origin) || !this.config.listen.allowedOrigins.includes(origin)) {
      throw new HttpError(403, "Origin is not allowed");
    }
  }

  private handleHttpError(response: ServerResponse, error: unknown): void {
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined);
      return;
    }

    if (error instanceof HttpError) {
      sendJson(response, error.status, { error: error.message });
      return;
    }

    console.error(`Request failed: ${errorMessage(error)}`);
    sendMcpError(response, 500, "Internal server error");
  }
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function resolveEnvironmentValues(
  values: Record<string, { fromEnv: string; prefix: string }>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([target, reference]) => {
      const value = process.env[reference.fromEnv];
      if (value === undefined) {
        throw new Error(`Required environment variable ${reference.fromEnv} is not set`);
      }
      return [target, `${reference.prefix}${value}`];
    }),
  );
}

async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    request.resume();
    throw new HttpError(413, "Request body is too large");
  }

  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > limit) {
      request.resume();
      throw new HttpError(413, "Request body is too large");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new HttpError(400, `Invalid JSON: ${errorMessage(error)}`);
  }
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    throw new HttpError(400, `Header ${name} must occur only once`);
  }
  return value;
}

function sendMcpError(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32_000, message },
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(body));
}

function toolError(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
