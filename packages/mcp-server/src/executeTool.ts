import { randomUUID } from "node:crypto";

import {
  GodotMcpException,
  authorize,
  type AuditSink,
  type CommandPolicy,
  type SessionGrants,
  type SessionService,
} from "@godot-mcp/control-plane";
import {
  GodotMcpErrorSchema,
  ToolResultSchema,
  type GodotMcpError,
  type ProjectIdentity,
  type ToolResult,
} from "@godot-mcp/protocol";

export interface ToolExecutionDependencies {
  project: ProjectIdentity;
  grants: SessionGrants;
  audit: AuditSink;
  session: SessionService;
}

export interface ExecutedPayload<T = unknown> {
  data: T;
  evidence?: string[];
  image?: { data: Uint8Array; mimeType: "image/png" };
}

export interface ExecutedToolResult {
  result: ToolResult;
  image?: ExecutedPayload["image"];
}

function normalizeError(error: unknown, correlationId: string): GodotMcpError {
  if (error instanceof GodotMcpException) {
    return GodotMcpErrorSchema.parse({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      correlationId,
      partialEffects: error.partialEffects,
      rollback: error.rollback,
    });
  }
  return GodotMcpErrorSchema.parse({
    code: "INVALID_REQUEST",
    message: error instanceof Error ? error.message : "Tool request failed",
    retryable: false,
    correlationId,
    partialEffects: false,
    rollback: "not_needed",
  });
}

export async function executeTool(
  dependencies: ToolExecutionDependencies,
  policy: CommandPolicy,
  argumentsValue: unknown,
  handler: (correlationId: string) => ExecutedPayload | Promise<ExecutedPayload>,
): Promise<ExecutedToolResult> {
  const correlationId = randomUUID();
  const startedAt = new Date().toISOString();
  try {
    authorize(dependencies.grants, policy);
    const payload = await handler(correlationId);
    const evidence = payload.evidence ?? [];
    const receipt = await dependencies.audit.append({
      correlationId,
      sessionId: dependencies.session.snapshot().attachment?.sessionId ?? null,
      projectId: dependencies.project.projectId,
      event: `tool.${policy.command}`,
      outcome: "success",
      permissionTier: policy.tier,
      startedAt,
      finishedAt: new Date().toISOString(),
      arguments: argumentsValue,
      errorCode: null,
      evidence,
    });
    return {
      result: ToolResultSchema.parse({
        ok: true,
        data: payload.data,
        warnings: [],
        evidence,
        changes: [],
        auditId: receipt.auditId,
        correlationId,
      }),
      ...(payload.image === undefined ? {} : { image: payload.image }),
    };
  } catch (error) {
    const normalized = normalizeError(error, correlationId);
    const receipt = await dependencies.audit.append({
      correlationId,
      sessionId: dependencies.session.snapshot().attachment?.sessionId ?? null,
      projectId: dependencies.project.projectId,
      event: `tool.${policy.command}`,
      outcome: "error",
      permissionTier: policy.tier,
      startedAt,
      finishedAt: new Date().toISOString(),
      arguments: argumentsValue,
      errorCode: normalized.code,
      evidence: [],
    });
    return {
      result: ToolResultSchema.parse({
        ok: false,
        data: { error: normalized },
        warnings: [],
        evidence: [],
        changes: [],
        auditId: receipt.auditId,
        correlationId,
      }),
    };
  }
}
