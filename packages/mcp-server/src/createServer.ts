import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { PRODUCT_VERSION } from "@godot-mcp/protocol";

import { registerCoreTools, type CoreToolDependencies } from "./registerCoreTools.js";
import { registerInputTools, type InputController } from "./registerInputTools.js";
import { registerEditorTools, type EditorController } from "./registerEditorTools.js";
import { registerRuntimeTools, type RuntimeController } from "./registerRuntimeTools.js";

export type GodotMcpServerDependencies = CoreToolDependencies & {
  runtime?: RuntimeController & Partial<InputController>;
  editor?: EditorController;
};

export function createGodotMcpServer(dependencies: GodotMcpServerDependencies): McpServer {
  const server = new McpServer({ name: "godot-mcp", version: PRODUCT_VERSION });
  registerCoreTools(server, dependencies);
  if (
    dependencies.runtime &&
    dependencies.grants.tiers.includes("runtime_control") &&
    dependencies.grants.packs.includes("runtime")
  ) registerRuntimeTools(server, { ...dependencies, runtime: dependencies.runtime });
  if (
    dependencies.runtime &&
    dependencies.runtime.input &&
    dependencies.grants.tiers.includes("runtime_control") &&
    dependencies.grants.packs.includes("input")
  ) registerInputTools(server, { ...dependencies, runtime: { input: dependencies.runtime.input.bind(dependencies.runtime) } });
  if (
    dependencies.editor &&
    dependencies.grants.tiers.includes("project_mutate") &&
    dependencies.grants.packs.includes("editor")
  ) registerEditorTools(server, { ...dependencies, editor: dependencies.editor });
  return server;
}
