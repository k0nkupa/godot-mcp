import { createHash } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { EDITOR_POLICY } from "@godot-mcp/control-plane";
import {
  EditorMutationInputSchema,
  ToolResultSchema,
  type EditorMutationInput,
  type EditorMutationResult,
} from "@godot-mcp/protocol";

import { executeTool, type ToolExecutionDependencies } from "./executeTool.js";
import { toMcpToolResult } from "./toolResult.js";

export interface EditorController {
  execute(input: EditorMutationInput, correlationId: string): Promise<EditorMutationResult>;
}

export interface EditorToolDependencies extends ToolExecutionDependencies {
  editor: EditorController;
}

export function summarizeEditorMutationForAudit(input: EditorMutationInput): Record<string, unknown> {
  if (input.operation === "undo" || input.operation === "redo") {
    return {
      operation: input.operation,
      actionId: input.actionId,
      idempotencyKeySha256: createHash("sha256").update(input.idempotencyKey).digest("hex"),
    };
  }
  const stepOperations: Record<string, number> = {};
  for (const step of input.steps) stepOperations[step.operation] = (stepOperations[step.operation] ?? 0) + 1;
  return {
    operation: input.operation,
    stepCount: input.steps.length,
    stepOperations,
    ...(input.operation === "apply"
      ? {
          expectedPlanDigest: input.expectedPlanDigest,
          idempotencyKeySha256: createHash("sha256").update(input.idempotencyKey).digest("hex"),
        }
      : { idempotencyKeySha256: null }),
  };
}

const annotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export function registerEditorTools(server: McpServer, dependencies: EditorToolDependencies): void {
  server.registerTool("godot_editor", {
    title: "Mutate Godot editor content",
    description: "Preview, apply, undo, or redo one bounded transactional editor batch in an authenticated project.",
    inputSchema: EditorMutationInputSchema,
    outputSchema: ToolResultSchema,
    annotations,
  }, async (input) => toMcpToolResult(await executeTool(
    dependencies,
    EDITOR_POLICY,
    input,
    async (correlationId) => {
      const data = await dependencies.editor.execute(input, correlationId);
      return {
        data,
        warnings: data.warnings,
        changes: data.changes,
        audit: data.audit,
      };
    },
    { auditArguments: summarizeEditorMutationForAudit(input) },
  )));
}
