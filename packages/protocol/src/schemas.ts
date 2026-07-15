import { z } from "zod";

export const PermissionTierSchema = z.enum([
  "observe",
  "runtime_control",
  "project_mutate",
  "project_operate",
  "unsafe_fixture",
]);

export const CapabilityPackSchema = z.enum([
  "core",
  "runtime",
  "input",
  "editor",
  "debug",
  "visual",
  "project",
  "unsafe",
]);

export const ProjectIdentitySchema = z.object({
  projectId: z.uuid(),
  rootRealPath: z.string().min(1),
  projectConfigSha256: z.string().regex(/^[a-f0-9]{64}$/),
  godotVersion: z.string().min(1).optional(),
});

export const BridgeEnvelopeSchema = z.object({
  sessionId: z.string().min(16),
  sequence: z.number().int().positive(),
  deadlineUnixMs: z.number().int().positive(),
  method: z.string().min(1),
  params: z.unknown(),
  mac: z.string().regex(/^[a-f0-9]{64}$/),
});

export const GodotMcpErrorSchema = z.object({
  code: z.enum([
    "NOT_ATTACHED",
    "AUTHENTICATION_FAILED",
    "PERMISSION_REQUIRED",
    "VERSION_MISMATCH",
    "PROJECT_CHANGED",
    "PATH_DENIED",
    "INVALID_REQUEST",
    "PAYLOAD_TOO_LARGE",
    "TARGET_NOT_FOUND",
    "STALE_HANDLE",
    "PRECONDITION_FAILED",
    "CONFLICT",
    "TIMEOUT",
    "CANCELLED",
    "GODOT_PARSE_ERROR",
    "GODOT_RUNTIME_ERROR",
    "ASSERTION_FAILED",
    "ROLLBACK_FAILED",
    "EXPORT_LEAK_DETECTED",
  ]),
  message: z.string(),
  retryable: z.boolean(),
  correlationId: z.string(),
  partialEffects: z.boolean(),
  rollback: z.enum(["not_needed", "succeeded", "failed", "not_attempted"]),
});

export const ToolResultSchema = z.object({
  ok: z.boolean(),
  data: z.unknown(),
  warnings: z.array(z.string()),
  evidence: z.array(z.string()),
  changes: z.array(z.unknown()),
  auditId: z.string(),
  correlationId: z.string(),
});

export const AuditRecordSchema = z.object({
  schemaVersion: z.literal(1),
  auditId: z.string(),
  correlationId: z.string(),
  sessionId: z.string().nullable(),
  projectId: z.string(),
  event: z.string(),
  outcome: z.string(),
  permissionTier: PermissionTierSchema,
  protocolVersion: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  arguments: z.unknown(),
  errorCode: z.string().nullable(),
});

export type PermissionTier = z.infer<typeof PermissionTierSchema>;
export type CapabilityPack = z.infer<typeof CapabilityPackSchema>;
export type ProjectIdentity = z.infer<typeof ProjectIdentitySchema>;
export type BridgeEnvelope = z.infer<typeof BridgeEnvelopeSchema>;
export type GodotMcpError = z.infer<typeof GodotMcpErrorSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
export type AuditRecord = z.infer<typeof AuditRecordSchema>;
