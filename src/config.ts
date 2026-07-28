import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const identifierSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9_-]+$/, "must contain only letters, numbers, underscores, or hyphens");

const publicToolNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "must contain only letters, numbers, underscores, or hyphens");

const environmentReferenceSchema = z.object({
  fromEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name"),
  prefix: z.string().default(""),
});

const streamableHttpServerSchema = z
  .object({
    transport: z.literal("streamable-http"),
    url: z.url().refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
      error: "must use http or https",
    }),
    auth: z.literal("oauth").optional(),
    headers: z.record(z.string().min(1), environmentReferenceSchema).default({}),
  })
  .superRefine((server, context) => {
    if (server.auth !== "oauth") {
      return;
    }

    const url = new URL(server.url);
    if (url.protocol !== "https:" && !isLoopbackHostname(url.hostname)) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "must use https for OAuth unless the server is on loopback",
      });
    }

    if (Object.keys(server.headers).some((name) => name.toLowerCase() === "authorization")) {
      context.addIssue({
        code: "custom",
        path: ["headers"],
        message: "must not configure an Authorization header together with auth: oauth",
      });
    }
  });

const stdioServerSchema = z.object({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  environment: z.record(z.string().min(1), environmentReferenceSchema).default({}),
});

const serverSchema = z.discriminatedUnion("transport", [
  streamableHttpServerSchema,
  stdioServerSchema,
]);

const exposedToolSchema = z.object({
  server: identifierSchema,
  tool: z.string().min(1),
  name: publicToolNameSchema.optional(),
  description: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
});

const configSchema = z.object({
  version: z.literal(1),
  listen: z
    .object({
      port: z.number().int().min(0).max(65_535).default(7331),
      allowedOrigins: z.array(z.url()).default([]),
      requestBodyLimitBytes: z.number().int().min(1).default(1_048_576),
      toolTimeoutMs: z.number().int().min(1).default(60_000),
    })
    .prefault({}),
  servers: z.record(identifierSchema, serverSchema),
  profiles: z.record(
    identifierSchema,
    z.object({
      tools: z.array(exposedToolSchema).min(1),
    }),
  ),
});

export type Config = z.infer<typeof configSchema>;
export type ServerConfig = Config["servers"][string];
export type ExposedToolConfig = Config["profiles"][string]["tools"][number];

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function defaultPublicToolName(server: string, tool: string): string {
  return `${server}__${tool.replaceAll(/[^A-Za-z0-9_-]/g, "_")}`;
}

export function publicToolName(tool: ExposedToolConfig): string {
  return tool.name ?? defaultPublicToolName(tool.server, tool.tool);
}

export function parseConfig(source: string): Config {
  let input: unknown;

  try {
    input = parseYaml(source);
  } catch (error) {
    throw new ConfigError(`Invalid YAML: ${errorMessage(error)}`, { cause: error });
  }

  const result = configSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigError(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }

  validateReferences(result.data);
  return result.data;
}

export async function loadConfig(path: string): Promise<Config> {
  let source: string;

  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new ConfigError(`Could not read configuration at ${path}: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  return parseConfig(source);
}

function validateReferences(config: Config): void {
  if (Object.keys(config.servers).length === 0) {
    throw new ConfigError("At least one upstream server must be configured");
  }

  if (Object.keys(config.profiles).length === 0) {
    throw new ConfigError("At least one profile must be configured");
  }

  for (const [profileName, profile] of Object.entries(config.profiles)) {
    const publicNames = new Set<string>();

    for (const tool of profile.tools) {
      if (!(tool.server in config.servers)) {
        throw new ConfigError(
          `Profile ${profileName} references unknown server ${tool.server} for tool ${tool.tool}`,
        );
      }

      const name = publicToolName(tool);
      const nameResult = publicToolNameSchema.safeParse(name);
      if (!nameResult.success) {
        throw new ConfigError(
          `Profile ${profileName} produces invalid public tool name ${JSON.stringify(name)}; ` +
            "set an explicit name containing at most 64 letters, numbers, underscores, or hyphens",
        );
      }

      if (publicNames.has(name)) {
        throw new ConfigError(`Profile ${profileName} exposes duplicate public tool name ${name}`);
      }

      publicNames.add(name);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isLoopbackHostname(hostname: string): boolean {
  return /^127(?:\.\d{1,3}){3}$/.test(hostname) || hostname === "[::1]";
}
