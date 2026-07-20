import { createHash } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { PROJECT_POLICY } from "@godot-mcp/control-plane";
import { ProjectOperationInputSchema, ToolResultSchema, type ProjectOperationInput } from "@godot-mcp/protocol";

import { executeTool, type ExecutedPayload, type ToolExecutionDependencies } from "./executeTool.js";
import { toMcpToolResult } from "./toolResult.js";

export interface ProjectOperationsController {
  execute(input: ProjectOperationInput, correlationId: string): Promise<ExecutedPayload>;
}

export interface ProjectToolDependencies extends ToolExecutionDependencies {
  projectOperations: ProjectOperationsController;
}

const annotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export function registerProjectTools(server: McpServer, dependencies: ProjectToolDependencies): void {
  server.registerTool("godot_project", {
    title: "Operate one authorized Godot project",
    description: "Apply bounded project settings or manage cancellable import, run, build, and export jobs with scanned artifacts.",
    inputSchema: ProjectOperationInputSchema,
    outputSchema: ToolResultSchema,
    annotations,
  }, async (input) => toMcpToolResult(await executeTool(
    dependencies,
    PROJECT_POLICY,
    input,
    async (correlationId) => dependencies.projectOperations.execute(input, correlationId),
    { auditArguments: projectAuditArguments(input) },
  )));
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function projectAuditArguments(input: ProjectOperationInput): Record<string, unknown> {
  if (input.operation === "settings_apply") {
    return {
      operation: input.operation,
      settingCount: input.changes.length,
      settingNameSha256: input.changes.map((change) => digest(change.name)).sort(),
    };
  }
  if (input.operation === "plugin_set") {
    return { operation: input.operation, pluginSha256: digest(input.pluginPath), enabled: input.enabled };
  }
  if (input.operation === "import_start") {
    return { operation: input.operation, kind: input.kind, resourceCount: input.resourcePaths?.length ?? 0, deadlineMs: input.deadlineMs };
  }
  if (input.operation === "run_start") {
    return { operation: input.operation, hasScene: input.scenePath !== undefined, headless: input.headless, deadlineMs: input.deadlineMs };
  }
  if (input.operation === "build_start") return { operation: input.operation, kind: input.kind, deadlineMs: input.deadlineMs };
  if (input.operation === "export_start") {
    return {
      operation: input.operation,
      presetSha256: digest(input.preset),
      artifactNameSha256: digest(input.artifactName),
      mode: input.mode,
      deadlineMs: input.deadlineMs,
    };
  }
  return { operation: input.operation };
}
