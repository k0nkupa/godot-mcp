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
    description: "Launch, inspect, wait, pause, step, resume, or stop one authenticated MCP-owned runtime.",
    inputSchema: RuntimeOperationInputSchema,
    outputSchema: ToolResultSchema,
    annotations: runtimeAnnotations,
  }, async (input) => toMcpToolResult(await executeTool(dependencies, RUNTIME_POLICY, input, async () => {
    if (input.operation === "launch") {
      return { data: await dependencies.runtime.launch({ scenePath: input.scenePath, startupTimeoutMs: input.startupTimeoutMs }) };
    }
    return { data: await dependencies.runtime.execute(input) };
  })));

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
      evidence.push(stored.uri);
      frames.push({ ...metadata, evidenceUri: stored.uri });
      images.push({ data: frame.data, mimeType: "image/png" as const });
    }
    return { data: { handle: input.handle, frames }, evidence, images };
  })));
}
