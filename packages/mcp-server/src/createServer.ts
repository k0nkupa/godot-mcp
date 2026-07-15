import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { PRODUCT_VERSION } from "@godot-mcp/protocol";

import { registerCoreTools, type CoreToolDependencies } from "./registerCoreTools.js";

export type GodotMcpServerDependencies = CoreToolDependencies;

export function createGodotMcpServer(dependencies: GodotMcpServerDependencies): McpServer {
  const server = new McpServer({ name: "godot-mcp", version: PRODUCT_VERSION });
  registerCoreTools(server, dependencies);
  return server;
}
