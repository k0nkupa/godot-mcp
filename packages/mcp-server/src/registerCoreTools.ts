import { randomUUID } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  CORE_CAPABILITIES_POLICY,
  CORE_CAPTURE_POLICY,
  CORE_DOCTOR_POLICY,
  CORE_HELP_POLICY,
  CORE_QUERY_POLICY,
  CORE_SESSION_POLICY,
  GodotMcpException,
  type AuditSink,
  type EvidenceStore,
  type SessionGrants,
  type SessionService,
} from "@godot-mcp/control-plane";
import {
  EditorCaptureInputSchema,
  EditorCaptureResultSchema,
  EditorQueryInputSchema,
  ToolResultSchema,
  type ProjectIdentity,
} from "@godot-mcp/protocol";

import { executeTool } from "./executeTool.js";
import { toMcpToolResult } from "./toolResult.js";

export interface BridgeCommandRequester {
  request<T>(
    method: "editor.query" | "editor.capture",
    params: unknown,
    options?: { timeoutMs?: number; maxResponseBytes?: number; correlationId?: string },
  ): Promise<{ requestId: string; data: T; binary?: Uint8Array; binarySha256?: string }>;
}

export interface CoreToolDependencies {
  project: ProjectIdentity;
  grants: SessionGrants;
  audit: AuditSink;
  session: SessionService;
  bridge: () => BridgeCommandRequester | null;
  evidence: EvidenceStore;
}

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function requireBridge(bridge: BridgeCommandRequester | null): BridgeCommandRequester {
  if (bridge) return bridge;
  throw new GodotMcpException({
    code: "NOT_ATTACHED",
    message: "Godot editor addon is not attached",
    retryable: true,
    correlationId: randomUUID(),
    partialEffects: false,
    rollback: "not_needed",
  });
}

export function registerCoreTools(server: McpServer, dependencies: CoreToolDependencies): void {
  server.registerTool("godot_session", {
    title: "Godot session status", description: "Read the attached Godot project, versions, state, and granted capabilities.",
    inputSchema: z.object({}), outputSchema: ToolResultSchema, annotations,
  }, async () => toMcpToolResult(await executeTool(dependencies, CORE_SESSION_POLICY, {}, () => ({ data: dependencies.session.snapshot() }))));

  server.registerTool("godot_capabilities", {
    title: "Godot capabilities", description: "List the operations visible to this least-privilege session.",
    inputSchema: z.object({}), outputSchema: ToolResultSchema, annotations,
  }, async () => toMcpToolResult(await executeTool(dependencies, CORE_CAPABILITIES_POLICY, {}, () => ({ data: dependencies.session.capabilities() }))));

  server.registerTool("godot_doctor", {
    title: "Godot MCP doctor", description: "Read installation, engine, bridge, and attachment health without changing the project.",
    inputSchema: z.object({}), outputSchema: ToolResultSchema, annotations,
  }, async () => toMcpToolResult(await executeTool(dependencies, CORE_DOCTOR_POLICY, {}, async () => ({ data: await dependencies.session.doctor() }))));

  server.registerTool("godot_help", {
    title: "Godot MCP help", description: "Read focused help for a core operation.",
    inputSchema: z.object({ operation: z.string().optional() }), outputSchema: ToolResultSchema, annotations,
  }, async ({ operation }) => toMcpToolResult(await executeTool(dependencies, CORE_HELP_POLICY, { operation }, () => ({ data: dependencies.session.help(operation as Parameters<SessionService["help"]>[0]) }))));

  server.registerTool("godot_query", {
    title: "Query Godot editor",
    description: "Read bounded editor state, open scene metadata, indexed resources, approved project settings, or redacted diagnostics.",
    inputSchema: EditorQueryInputSchema, outputSchema: ToolResultSchema, annotations,
  }, async (input) => toMcpToolResult(await executeTool(dependencies, CORE_QUERY_POLICY, input, async (correlationId) => {
    const response = await requireBridge(dependencies.bridge()).request<unknown>("editor.query", input, {
      timeoutMs: 10_000, maxResponseBytes: 512 * 1024, correlationId,
    });
    return { data: response.data };
  })));

  server.registerTool("godot_capture", {
    title: "Capture Godot editor viewport",
    description: "Return a bounded PNG from the current 2D or selected 3D editor viewport.",
    inputSchema: EditorCaptureInputSchema, outputSchema: ToolResultSchema, annotations,
  }, async (input) => toMcpToolResult(await executeTool(dependencies, CORE_CAPTURE_POLICY, input, async (correlationId) => {
    const response = await requireBridge(dependencies.bridge()).request<Record<string, unknown>>("editor.capture", input, {
      timeoutMs: 15_000, maxResponseBytes: 8 * 1024 * 1024, correlationId,
    });
    if (!response.binary) throw new Error("Godot capture response omitted PNG bytes");
    const metadata = EditorCaptureResultSchema.parse(response.data);
    const expectedViewportIndex = input.viewport === "3d" ? input.viewportIndex ?? 0 : null;
    if (
      metadata.viewport !== input.viewport ||
      (metadata.viewportIndex ?? null) !== expectedViewportIndex ||
      metadata.width > input.maxWidth ||
      metadata.height > input.maxHeight ||
      metadata.byteLength !== response.binary.byteLength ||
      metadata.sha256 !== response.binarySha256
    ) {
      throw new Error("Godot capture metadata does not match verified PNG bytes or request bounds");
    }
    const attachment = dependencies.session.snapshot().attachment;
    if (!attachment) return requireBridge(null) as never;
    const viewport = metadata.viewport;
    const width = metadata.width;
    const height = metadata.height;
    const evidence = await dependencies.evidence.putPng(attachment.sessionId, response.binary, {
      viewport, width, height, ...(viewport === "3d" ? { viewportIndex: input.viewportIndex ?? 0 } : {}),
    });
    return {
      data: { ...metadata, sha256: evidence.sha256, byteLength: evidence.byteLength, evidenceUri: evidence.uri },
      evidence: [evidence.uri],
      image: { data: response.binary, mimeType: "image/png" },
    };
  })));
}
