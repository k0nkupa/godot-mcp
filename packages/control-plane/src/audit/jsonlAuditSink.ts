import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  AuditRecordSchema,
  BRIDGE_PROTOCOL_VERSION,
  type AuditRecord,
  type PermissionTier,
} from "@godot-mcp/protocol";

import { redactAuditValue } from "./redact.js";

export interface AuditInput {
  auditId?: string;
  correlationId?: string;
  sessionId: string | null;
  projectId: string;
  event: string;
  outcome: string;
  permissionTier: PermissionTier;
  protocolVersion?: string;
  startedAt?: string;
  finishedAt?: string;
  arguments: unknown;
  errorCode: string | null;
  evidence?: string[];
  targetIdentities?: unknown[];
  preconditions?: unknown[];
  changes?: unknown[];
  idempotencyKeySha256?: string | null;
  partialEffects?: boolean;
  rollback?: AuditRecord["rollback"];
}

export interface AuditSink {
  append(input: AuditInput): Promise<AuditRecord>;
}

function buildAuditRecord(input: AuditInput): AuditRecord {
  const timestamp = new Date().toISOString();
  return AuditRecordSchema.parse({
    schemaVersion: 2,
    auditId: input.auditId ?? randomUUID(),
    correlationId: input.correlationId ?? randomUUID(),
    sessionId: input.sessionId,
    projectId: input.projectId,
    event: input.event,
    outcome: input.outcome,
    permissionTier: input.permissionTier,
    protocolVersion: input.protocolVersion ?? BRIDGE_PROTOCOL_VERSION,
    startedAt: input.startedAt ?? timestamp,
    finishedAt: input.finishedAt ?? timestamp,
    arguments: redactAuditValue(input.arguments),
    errorCode: input.errorCode,
    evidence: input.evidence ?? [],
    targetIdentities: input.targetIdentities ?? [],
    preconditions: input.preconditions ?? [],
    changes: input.changes ?? [],
    idempotencyKeySha256: input.idempotencyKeySha256 ?? null,
    partialEffects: input.partialEffects ?? false,
    rollback: input.rollback ?? "not_needed",
  });
}

export class JsonlAuditSink implements AuditSink {
  private tail: Promise<unknown> = Promise.resolve();

  static forProject(projectRoot: string): JsonlAuditSink {
    return new JsonlAuditSink(join(projectRoot, ".godot/evidence/godot-mcp/audit.jsonl"));
  }

  constructor(private readonly path: string) {}

  append(input: AuditInput): Promise<AuditRecord> {
    const record = buildAuditRecord(input);
    const write = this.tail.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const handle = await open(this.path, "a", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return record;
    });
    this.tail = write.catch(() => undefined);
    return write;
  }
}
