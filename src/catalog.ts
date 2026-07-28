import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { type Config, publicToolName } from "./config.ts";

export interface RoutedTool {
  descriptor: Tool;
  publicName: string;
  serverId: string;
  sourceName: string;
}

export type DiscoveredTools = ReadonlyMap<string, ReadonlyMap<string, Tool>>;

export class CatalogError extends Error {
  override name = "CatalogError";
}

export function buildProfileCatalog(
  config: Config,
  profileName: string,
  discoveredTools: DiscoveredTools,
  strict = true,
): ReadonlyMap<string, RoutedTool> {
  const profile = config.profiles[profileName];
  if (!profile) {
    throw new CatalogError(`Unknown profile ${profileName}`);
  }

  const catalog = new Map<string, RoutedTool>();

  for (const exposed of profile.tools) {
    const source = discoveredTools.get(exposed.server)?.get(exposed.tool);
    if (!source) {
      if (strict) {
        throw new CatalogError(
          `Profile ${profileName} references missing tool ${exposed.server}/${exposed.tool}`,
        );
      }
      continue;
    }

    if (source.execution?.taskSupport === "required") {
      if (strict) {
        throw new CatalogError(
          `Tool ${exposed.server}/${exposed.tool} requires MCP task execution, which is not supported yet`,
        );
      }
      continue;
    }

    const name = publicToolName(exposed);
    const descriptor: Tool = {
      ...source,
      name,
      ...(exposed.description === undefined ? {} : { description: exposed.description }),
      ...(exposed.title === undefined ? {} : { title: exposed.title }),
    };

    catalog.set(name, {
      descriptor,
      publicName: name,
      serverId: exposed.server,
      sourceName: exposed.tool,
    });
  }

  return catalog;
}
