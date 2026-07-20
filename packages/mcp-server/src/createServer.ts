import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { PRODUCT_VERSION } from "@godot-mcp/protocol";

import { registerCoreTools, type CoreToolDependencies } from "./registerCoreTools.js";
import { registerInputTools, type InputController } from "./registerInputTools.js";
import { registerEditorTools, type EditorController } from "./registerEditorTools.js";
import { registerRuntimeTools, type RuntimeController } from "./registerRuntimeTools.js";
import { registerVisualTools, type VisualController } from "./registerVisualTools.js";
import { registerProjectTools, type ProjectOperationsController } from "./registerProjectTools.js";
import { registerUnsafeTools, type UnsafeFixtureController } from "./registerUnsafeTools.js";
import { registerExtensionTools, type ExtensionToolDependencies } from "./registerExtensionTools.js";

export type GodotMcpServerDependencies = CoreToolDependencies & {
  runtime?: RuntimeController & Partial<InputController>;
  editor?: EditorController;
  visual?: VisualController;
  projectOperations?: ProjectOperationsController;
  unsafeFixture?: UnsafeFixtureController;
  extensions?: ExtensionToolDependencies["extensions"];
  extensionContext?: ExtensionToolDependencies["extensionContext"];
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
  if (
    dependencies.visual &&
    dependencies.grants.tiers.includes("runtime_control") &&
    dependencies.grants.packs.includes("runtime") &&
    dependencies.grants.packs.includes("input") &&
    dependencies.grants.packs.includes("visual")
  ) registerVisualTools(server, { ...dependencies, visual: dependencies.visual });
  if (
    dependencies.projectOperations &&
    dependencies.grants.tiers.includes("project_operate") &&
    dependencies.grants.packs.includes("project")
  ) registerProjectTools(server, { ...dependencies, projectOperations: dependencies.projectOperations });
  if (
    dependencies.unsafeFixture &&
    dependencies.grants.tiers.includes("unsafe_fixture") &&
    dependencies.grants.packs.includes("unsafe")
  ) registerUnsafeTools(server, { ...dependencies, unsafeFixture: dependencies.unsafeFixture });
  if (dependencies.extensions?.visible(dependencies.grants) && dependencies.extensionContext) {
    registerExtensionTools(server, { ...dependencies, extensions: dependencies.extensions, extensionContext: dependencies.extensionContext });
  }
  return server;
}
