#!/usr/bin/env node

import { resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { Gateway } from "./gateway.ts";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (args.version) {
    console.log(VERSION);
    return;
  }

  const configPath = resolve(args.configPath ?? "context-manager.yaml");
  const config = await loadConfig(configPath);
  const gateway = await Gateway.create(config);
  const baseUrl = await gateway.listen();

  console.log(`Context manager ${VERSION} is listening on ${baseUrl.origin}`);
  for (const profileName of gateway.profileNames()) {
    console.log(`  ${profileName}: ${new URL(`/mcp/${profileName}`, baseUrl).href}`);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down`);
    await gateway.close();
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

interface Arguments {
  configPath?: string;
  help: boolean;
  version: boolean;
}

function parseArguments(args: string[]): Arguments {
  const result: Arguments = { help: false, version: false };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      result.help = true;
    } else if (argument === "--version" || argument === "-v") {
      result.version = true;
    } else if (argument === "--config" || argument === "-c") {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`${argument} requires a path`);
      }
      result.configPath = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return result;
}

function printHelp(): void {
  console.log(`Usage: context-manager [options]

Options:
  -c, --config <path>  Configuration file (default: context-manager.yaml)
  -h, --help           Show this help
  -v, --version        Show the version`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
