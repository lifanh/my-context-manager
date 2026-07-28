# My Context Manager

A local-first MCP gateway that curates tools from multiple upstream MCP servers. Each
profile is exposed as its own Streamable HTTP endpoint, with an explicit allowlist and
optional public name, title, and description overrides.

## Status

The first vertical slice supports:

- Streamable HTTP and stdio upstream MCP servers
- Complete paginated tool discovery
- Explicit profile tool allowlists
- Tool renaming and description/title overrides
- Stateful downstream Streamable HTTP sessions
- Tool-call routing, cancellation, and timeouts
- Upstream `tools/list_changed` propagation
- Environment-backed HTTP headers and stdio credentials
- OAuth browser authorization with PKCE, refresh, and OS credential storage
- Loopback-only listening and strict Origin checks

Hot configuration reload and the management UI are the next milestones.

## Development

The repository uses [Vite+](https://viteplus.dev/) and TypeScript 7.

```sh
vp install
cp context-manager.example.yaml context-manager.yaml
vp run dev -- --config context-manager.yaml
```

Run the project checks with:

```sh
vp check
vp test
vp pack
```

## Configuration

Copy [`context-manager.example.yaml`](./context-manager.example.yaml) and configure the
upstream servers and profiles you want to expose. Secret header and environment values
are references to the gateway process environment; secret values are never stored in
the YAML file.

Given a `coding` profile and the default port, configure an MCP client with:

```text
http://127.0.0.1:7331/mcp/coding
```

The process also exposes `GET /healthz` for local health checks.

### OAuth upstreams

Set `auth: oauth` on a Streamable HTTP server, then authorize it explicitly:

```yaml
servers:
  remote:
    transport: streamable-http
    url: https://mcp.example.com/mcp
    auth: oauth
```

```sh
context-manager auth login remote --config context-manager.yaml
```

The command discovers the OAuth endpoints, dynamically registers the client when
required, opens a browser with S256 PKCE protection, and stores the resulting client
registration and tokens in the operating system credential store. The callback listens
on `127.0.0.1:7332` for up to five minutes. Normal gateway startup never opens a browser;
it refreshes saved credentials when possible or reports the login command to run.
