import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  INPUT_POLICY,
  summarizeInputForAudit,
} from "@godot-mcp/control-plane";
import {
  InputOperationInputSchema,
  ToolResultSchema,
  type InputOperationInput,
  type InputOperationResult,
} from "@godot-mcp/protocol";

import { executeTool, type ToolExecutionDependencies } from "./executeTool.js";
import { toMcpToolResult } from "./toolResult.js";

export interface InputController {
  input(input: InputOperationInput): Promise<InputOperationResult>;
}

export interface InputToolDependencies extends ToolExecutionDependencies {
  runtime: InputController;
}

const inputAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export function registerInputTools(server: McpServer, dependencies: InputToolDependencies): void {
  server.registerTool("godot_input", {
    title: "Automate ephemeral Godot runtime input",
    description: "Inject bounded events, sequences, recordings, and deterministic replays into an authenticated MCP-owned runtime.",
    inputSchema: InputOperationInputSchema,
    outputSchema: ToolResultSchema,
    annotations: inputAnnotations,
  }, async (input) => toMcpToolResult(await executeTool(
    dependencies,
    INPUT_POLICY,
    input,
    async () => ({ data: await dependencies.runtime.input(input) }),
    { auditArguments: summarizeInputForAudit(input) },
  )));
}
