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

  test("accepts OAuth for Streamable HTTP servers", () => {
    const config = parseConfig(validConfig.replace("    url:", "    auth: oauth\n    url:"));

    expect(config.servers.source).toMatchObject({
      transport: "streamable-http",
      auth: "oauth",
    });
  });

  test("requires secure OAuth URLs and reserves the Authorization header", () => {
    expect(() =>
      parseConfig(
        validConfig
          .replace("https://example.com", "http://example.com")
          .replace("    url:", "    auth: oauth\n    url:"),
      ),
    ).toThrowError(/must use https for OAuth/);

    expect(() =>
      parseConfig(
        validConfig.replace(
          "    url: https://example.com/mcp",
          `    url: https://example.com/mcp
    auth: oauth
    headers:
      Authorization:
        fromEnv: TOKEN`,
        ),
      ),
    ).toThrowError(/must not configure an Authorization header/);
  });

  test("accepts the full IPv4 loopback range for local OAuth", () => {
    const config = parseConfig(
      validConfig
        .replace("https://example.com", "http://127.0.0.2")
        .replace("    url:", "    auth: oauth\n    url:"),
    );

    expect(config.servers.source).toMatchObject({ auth: "oauth" });
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
