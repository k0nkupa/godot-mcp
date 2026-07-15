import { randomUUID } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  CORE_CAPABILITIES_POLICY,
  CORE_DOCTOR_POLICY,
  CORE_HELP_POLICY,
  CORE_SESSION_POLICY,
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

import { toMcpToolResult } from "./toolResult.js";

export interface CoreToolDependencies {
  project: ProjectIdentity;
  grants: SessionGrants;
  audit: AuditSink;
  session: SessionService;
}

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

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

async function executeTool(
  dependencies: CoreToolDependencies,
  policy: CommandPolicy,
  argumentsValue: unknown,
  handler: () => unknown | Promise<unknown>,
): Promise<ToolResult> {
  const correlationId = randomUUID();
  const startedAt = new Date().toISOString();
  try {
    authorize(dependencies.grants, policy);
    const data = await handler();
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
    });
    return ToolResultSchema.parse({
      ok: true,
      data,
      warnings: [],
      evidence: [],
      changes: [],
      auditId: receipt.auditId,
      correlationId,
    });
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
    });
    return ToolResultSchema.parse({
      ok: false,
      data: { error: normalized },
      warnings: [],
      evidence: [],
      changes: [],
      auditId: receipt.auditId,
      correlationId,
    });
  }
}

export function registerCoreTools(server: McpServer, dependencies: CoreToolDependencies): void {
  server.registerTool(
    "godot_session",
    {
      title: "Godot session status",
      description: "Read the attached Godot project, versions, state, and granted capabilities.",
      inputSchema: z.object({}),
      outputSchema: ToolResultSchema,
      annotations,
    },
    async () => toMcpToolResult(
      await executeTool(dependencies, CORE_SESSION_POLICY, {}, () => dependencies.session.snapshot()),
    ),
  );

  server.registerTool(
    "godot_capabilities",
    {
      title: "Godot capabilities",
      description: "List the operations visible to this least-privilege session.",
      inputSchema: z.object({}),
      outputSchema: ToolResultSchema,
      annotations,
    },
    async () => toMcpToolResult(
      await executeTool(
        dependencies,
        CORE_CAPABILITIES_POLICY,
        {},
        () => dependencies.session.capabilities(),
      ),
    ),
  );

  server.registerTool(
    "godot_doctor",
    {
      title: "Godot MCP doctor",
      description: "Read installation, engine, bridge, and attachment health without changing the project.",
      inputSchema: z.object({}),
      outputSchema: ToolResultSchema,
      annotations,
    },
    async () => toMcpToolResult(
      await executeTool(dependencies, CORE_DOCTOR_POLICY, {}, () => dependencies.session.doctor()),
    ),
  );

  server.registerTool(
    "godot_help",
    {
      title: "Godot MCP help",
      description: "Read focused help for a Phase 1 core operation.",
      inputSchema: z.object({ operation: z.string().optional() }),
      outputSchema: ToolResultSchema,
      annotations,
    },
    async ({ operation }) => toMcpToolResult(
      await executeTool(
        dependencies,
        CORE_HELP_POLICY,
        { operation },
        () => dependencies.session.help(operation as Parameters<SessionService["help"]>[0]),
      ),
    ),
  );
}
