import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test } from "vite-plus/test";
import { buildProfileCatalog, CatalogError } from "../src/catalog.ts";
import { parseConfig } from "../src/config.ts";

const config = parseConfig(`
version: 1
servers:
  source:
    transport: streamable-http
    url: https://example.com/mcp
profiles:
  coding:
    tools:
      - server: source
        tool: issues.get
        name: issue_get
        title: Issue reader
        description: Read one issue by number.
`);

const sourceTool: Tool = {
  name: "issues.get",
  description: "Original description",
  inputSchema: {
    type: "object",
    properties: { number: { type: "number" } },
    required: ["number"],
  },
  annotations: { readOnlyHint: true },
};

describe("buildProfileCatalog", () => {
  test("rewrites presentation while preserving schemas and annotations", () => {
    const catalog = buildProfileCatalog(
      config,
      "coding",
      new Map([["source", new Map([[sourceTool.name, sourceTool]])]]),
    );
    const routed = catalog.get("issue_get");

    expect(routed).toMatchObject({
      publicName: "issue_get",
      serverId: "source",
      sourceName: "issues.get",
    });
    expect(routed?.descriptor).toEqual({
      ...sourceTool,
      name: "issue_get",
      title: "Issue reader",
      description: "Read one issue by number.",
    });
  });

  test("rejects tools that require task execution", () => {
    const requiredTaskTool: Tool = {
      ...sourceTool,
      execution: { taskSupport: "required" },
    };

    expect(() =>
      buildProfileCatalog(
        config,
        "coding",
        new Map([["source", new Map([[requiredTaskTool.name, requiredTaskTool]])]]),
      ),
    ).toThrowError(CatalogError);
  });
});
