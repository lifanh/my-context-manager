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
- Loopback-only listening and strict Origin checks

OAuth browser authorization, encrypted credential storage, hot configuration reload,
and the management UI are the next milestones.

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
