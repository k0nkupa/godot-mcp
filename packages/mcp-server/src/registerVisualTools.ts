import { createHash } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { VISUAL_POLICY } from "@godot-mcp/control-plane";
import {
  ToolResultSchema,
  VisualOperationInputSchema,
  type VisualOperationInput,
} from "@godot-mcp/protocol";

import { executeTool, type ExecutedPayload, type ToolExecutionDependencies } from "./executeTool.js";
import { toMcpToolResult } from "./toolResult.js";

export interface VisualController {
  execute(input: VisualOperationInput): Promise<ExecutedPayload>;
}

export interface VisualToolDependencies extends ToolExecutionDependencies {
  visual: VisualController;
}

const visualAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export function registerVisualTools(server: McpServer, dependencies: VisualToolDependencies): void {
  server.registerTool("godot_visual", {
    title: "Run bounded Godot visual QA",
    description: "Manage immutable PNG baselines, deterministic comparisons, and cancellable authenticated playtest scenarios.",
    inputSchema: VisualOperationInputSchema,
    outputSchema: ToolResultSchema,
    annotations: visualAnnotations,
  }, async (input) => toMcpToolResult(await executeTool(
    dependencies,
    VISUAL_POLICY,
    input,
    async () => dependencies.visual.execute(input),
    { auditArguments: visualAuditArguments(input) },
  )));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function visualAuditArguments(input: VisualOperationInput): Record<string, unknown> {
  if (input.operation === "scenario_start") {
    const stepKinds: Record<string, number> = {};
    for (const step of input.scenario.steps) stepKinds[step.kind] = (stepKinds[step.kind] ?? 0) + 1;
    return {
      operation: input.operation,
      scenarioNameSha256: sha256(input.scenario.name),
      stepCount: input.scenario.steps.length,
      stepKinds,
      deadlineMs: input.scenario.deadlineMs,
    };
  }
  if (input.operation === "baseline_create" || input.operation === "compare") {
    const observationSha256 = input.observationUri.split("/")[3];
    return {
      operation: input.operation,
      baselineNameSha256: sha256(input.name),
      ...(observationSha256 ? { observationSha256 } : {}),
      ...(input.operation === "compare" ? {
        maskCount: input.settings.masks.length,
        maxChannelDelta: input.settings.maxChannelDelta,
        maxDifferentPixels: input.settings.maxDifferentPixels,
        maxDifferentRatioMillionths: input.settings.maxDifferentRatioMillionths,
      } : {}),
    };
  }
  if (input.operation === "baseline_get") return { operation: input.operation, baselineNameSha256: sha256(input.name) };
  return { operation: input.operation };
}
