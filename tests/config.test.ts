import { describe, expect, test } from "vite-plus/test";
import { ConfigError, parseConfig } from "../src/config.ts";

const validConfig = `
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
`;

describe("parseConfig", () => {
  test("applies local-first defaults", () => {
    const config = parseConfig(validConfig);

    expect(config.listen).toEqual({
      port: 7331,
      allowedOrigins: [],
      requestBodyLimitBytes: 1_048_576,
      toolTimeoutMs: 60_000,
    });
    expect(config.servers.source?.transport).toBe("streamable-http");
  });

  test("rejects unknown server references", () => {
    expect(() =>
      parseConfig(validConfig.replace("server: source", "server: missing")),
    ).toThrowError(/unknown server missing/);
  });

  test("rejects duplicate public names within a profile", () => {
    const duplicate = validConfig.replace(
      "        name: issue_get",
      `        name: issue_get
      - server: source
        tool: issues.list
        name: issue_get`,
    );

    expect(() => parseConfig(duplicate)).toThrowError(ConfigError);
    expect(() => parseConfig(duplicate)).toThrowError(/duplicate public tool name issue_get/);
  });
});
