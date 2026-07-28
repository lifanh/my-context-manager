import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "vite-plus/test";
import { parseConfig } from "../src/config.ts";
import { Gateway } from "../src/gateway.ts";

test("discovers, rewrites, and routes an upstream tool", async () => {
  const fixture = fileURLToPath(new URL("./fixtures/upstream.mjs", import.meta.url));
  const config = parseConfig(`
version: 1
listen:
  port: 0
servers:
  fixture:
    transport: stdio
    command: ${JSON.stringify(process.execPath)}
    args:
      - ${JSON.stringify(fixture)}
profiles:
  testing:
    tools:
      - server: fixture
        tool: source.echo
        name: echo
        description: Echo a message through the gateway.
`);

  const gateway = await Gateway.create(config);
  const baseUrl = await gateway.listen();
  const client = new Client({ name: "gateway-test", version: "1.0.0" });

  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp/testing", baseUrl)));

    const list = await client.listTools();
    expect(list.tools).toEqual([
      expect.objectContaining({
        name: "echo",
        description: "Echo a message through the gateway.",
        annotations: { readOnlyHint: true },
      }),
    ]);

    const result = await client.callTool({ name: "echo", arguments: { message: "hello" } });
    expect(result).toMatchObject({
      content: [{ type: "text", text: "upstream:hello" }],
    });

    const rejectedOrigin = await fetch(new URL("/healthz", baseUrl), {
      headers: { origin: "https://attacker.example" },
    });
    expect(rejectedOrigin.status).toBe(403);
  } finally {
    await client.close();
    await gateway.close();
  }
});
