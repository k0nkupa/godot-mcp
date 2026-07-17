import { createHash } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  RUNTIME_CAPTURE_POLICY,
  RUNTIME_POLICY,
  type EvidenceStore,
} from "@godot-mcp/control-plane";
import {
  RuntimeCaptureFrameMetadataSchema,
  RuntimeCaptureInputSchema,
  RuntimeOperationInputSchema,
  ToolResultSchema,
  type RuntimeCaptureInput,
  type RuntimeOperationInput,
} from "@godot-mcp/protocol";

import { executeTool, type ToolExecutionDependencies } from "./executeTool.js";
import { toMcpToolResult } from "./toolResult.js";

export interface RuntimeFrame {
  data: Uint8Array;
  metadata: {
    mimeType: "image/png";
    width: number;
    height: number;
    byteLength: number;
    sha256: string;
    frameIndex: number;
  };
}

export interface RuntimeController {
  launch(input: { scenePath: string; startupTimeoutMs: number }): Promise<unknown>;
  execute(input: Exclude<RuntimeOperationInput, { operation: "launch" }>): Promise<unknown>;
  capture(input: RuntimeCaptureInput): Promise<{ frames: RuntimeFrame[] }>;
}

export interface RuntimeToolDependencies extends ToolExecutionDependencies {
  evidence: EvidenceStore;
  runtime: RuntimeController;
}

const runtimeAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const captureAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export function registerRuntimeTools(server: McpServer, dependencies: RuntimeToolDependencies): void {
  server.registerTool("godot_runtime", {
    title: "Control ephemeral Godot runtime",
    description: "Launch, inspect, debug, profile, control, or stop one authenticated MCP-owned runtime.",
    inputSchema: RuntimeOperationInputSchema,
    outputSchema: ToolResultSchema,
    annotations: runtimeAnnotations,
  }, async (input) => toMcpToolResult(await executeTool(dependencies, RUNTIME_POLICY, input, async () => {
    if (input.operation === "launch") {
      return { data: await dependencies.runtime.launch({ scenePath: input.scenePath, startupTimeoutMs: input.startupTimeoutMs }) };
    }
    const data = await dependencies.runtime.execute(input);
    const audit = performanceAuditFacts(input, data);
    return { data, ...(audit === undefined ? {} : { audit }) };
  }, { auditArguments: runtimeAuditArguments(input) })));

  server.registerTool("godot_runtime_capture", {
    title: "Capture ephemeral Godot runtime",
    description: "Return one to eight bounded PNG frames from the authenticated MCP-owned runtime.",
    inputSchema: RuntimeCaptureInputSchema,
    outputSchema: ToolResultSchema,
    annotations: captureAnnotations,
  }, async (input) => toMcpToolResult(await executeTool(dependencies, RUNTIME_CAPTURE_POLICY, input, async () => {
    const captured = await dependencies.runtime.capture(input);
    if (captured.frames.length !== input.frameCount) throw new Error("Runtime capture returned an unexpected frame count");
    const attachment = dependencies.session.snapshot().attachment;
    if (!attachment) throw new Error("Godot editor addon is not attached");
    const evidence: string[] = [];
    const frames = [];
    const images = [];
    for (const [frameIndex, frame] of captured.frames.entries()) {
      const metadata = RuntimeCaptureFrameMetadataSchema.parse(frame.metadata);
      const digest = createHash("sha256").update(frame.data).digest("hex");
      if (
        metadata.frameIndex !== frameIndex ||
        metadata.byteLength !== frame.data.byteLength ||
        metadata.sha256 !== digest ||
        metadata.width > input.maxWidth ||
        metadata.height > input.maxHeight
      ) throw new Error("Runtime capture metadata does not match verified PNG bytes or request bounds");
      const stored = await dependencies.evidence.putPng(attachment.sessionId, frame.data, {
        source: "runtime",
        viewport: "runtime",
        width: metadata.width,
        height: metadata.height,
        runId: input.handle.runId,
        generation: input.handle.generation,
        frameIndex,
      });
      evidence.push(stored.observationUri);
      frames.push({ ...metadata, evidenceUri: stored.uri, evidenceObservationUri: stored.observationUri });
      images.push({ data: frame.data, mimeType: "image/png" as const });
    }
    return { data: { handle: input.handle, frames }, evidence, images };
  })));
}

function runtimeAuditArguments(input: RuntimeOperationInput): unknown {
  if (input.operation === "monitor_snapshot") return { operation: input.operation, groupCount: input.groups.length };
  if (input.operation === "profile_start") {
    return {
      operation: input.operation,
      durationMs: input.durationMs,
      intervalFrames: input.intervalFrames,
      groupCount: input.groups.length,
      retainRaw: input.retainRaw,
    };
  }
  if (input.operation === "profile_status" || input.operation === "profile_cancel" || input.operation === "profile_result") {
    return { operation: input.operation };
  }
  if (input.operation === "debug_breakpoints_set") {
    return {
      operation: input.operation,
      breakpointCount: input.breakpoints.length,
      sourceCount: new Set(input.breakpoints.map((entry) => entry.sourcePath)).size,
    };
  }
  if (input.operation === "debug_watch") {
    return {
      operation: input.operation,
      selectorCount: input.selectors.length,
      maxDepth: Math.max(...input.selectors.map((selector) => selector.path.length)),
    };
  }
  if (input.operation === "debug_stack") return { operation: input.operation, offset: input.offset, limit: input.limit };
  if (input.operation === "debug_variables") return { operation: input.operation, scope: input.scope, offset: input.offset, limit: input.limit };
  if (input.operation === "debug_children") return { operation: input.operation, offset: input.offset, limit: input.limit };
  if (input.operation === "debug_wait") return { operation: input.operation, afterSequence: input.afterSequence, timeoutMs: input.timeoutMs };
  if (input.operation.startsWith("debug_")) return { operation: input.operation };
  return input;
}

function performanceAuditFacts(input: RuntimeOperationInput, data: unknown) {
  if (input.operation !== "monitor_snapshot" && !input.operation.startsWith("profile_")) return undefined;
  const record = isRecord(data) ? data : {};
  const evidence = isRecord(record.evidence) ? record.evidence : {};
  const metadata = {
    kind: "runtime_performance",
    operation: input.operation,
    ...(typeof record.state === "string" ? { state: record.state } : {}),
    ...(typeof record.observedSamples === "number" ? { observedSamples: record.observedSamples } : {}),
    ...(typeof record.retainedSamples === "number" ? { retainedSamples: record.retainedSamples } : {}),
    ...(typeof evidence.sha256 === "string" ? { sha256: evidence.sha256 } : {}),
    ...(input.operation === "monitor_snapshot" && isRecord(record.groups) ? { groupCount: Object.keys(record.groups).length } : {}),
  };
  return {
    targetIdentities: [metadata],
    preconditions: [],
    idempotencyKeySha256: null,
    partialEffects: false,
    rollback: "not_needed" as const,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
