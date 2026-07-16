import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { EditorMutationResultSchema, type EditorMutationResult } from "@godot-mcp/protocol";
import { z } from "zod";

import { GodotMcpException } from "../errors.js";

const MAX_LEDGER_BYTES = 4 * 1024 * 1024;
const MAX_KEYS = 256;
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const StartedRecordSchema = z.object({
  schemaVersion: z.literal(1),
  state: z.literal("started"),
  idempotencyKeySha256: Sha256Schema,
  requestDigest: Sha256Schema,
  correlationId: z.string().min(1).max(256),
  recordedAt: z.string().datetime(),
}).strict();

const CompletedRecordSchema = z.object({
  schemaVersion: z.literal(1),
  state: z.literal("completed"),
  idempotencyKeySha256: Sha256Schema,
  requestDigest: Sha256Schema,
  correlationId: z.string().min(1).max(256),
  recordedAt: z.string().datetime(),
  result: EditorMutationResultSchema,
}).strict();

const LedgerRecordSchema = z.discriminatedUnion("state", [StartedRecordSchema, CompletedRecordSchema]);
type LedgerRecord = z.infer<typeof LedgerRecordSchema>;

export interface MutationLedgerKeyInput {
  idempotencyKey: string;
  requestDigest: string;
  correlationId: string;
}

export interface MutationLedgerCompleteInput extends MutationLedgerKeyInput {
  result: EditorMutationResult;
}

export type MutationReconciliation =
  | { state: "missing" }
  | { state: "unknown" }
  | { state: "completed"; result: EditorMutationResult };

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function conflict(message: string): GodotMcpException {
  return new GodotMcpException({
    code: "CONFLICT",
    message,
    retryable: false,
    correlationId: randomUUID(),
    partialEffects: false,
    rollback: "not_attempted",
  });
}

export class MutationLedger {
  private readonly latest = new Map<string, LedgerRecord>();
  private tail: Promise<unknown> = Promise.resolve();

  static async open(path: string): Promise<MutationLedger> {
    const ledger = new MutationLedger(path);
    let metadata;
    try {
      metadata = await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return ledger;
      throw error;
    }
    if (metadata.size > MAX_LEDGER_BYTES) {
      throw conflict("Mutation journal exceeds 4 MiB; inspect and archive it outside MCP before reconnecting");
    }
    const text = await readFile(path, "utf8");
    for (const [index, line] of text.split("\n").entries()) {
      if (line.length === 0) continue;
      try {
        ledger.remember(LedgerRecordSchema.parse(JSON.parse(line) as unknown));
      } catch {
        throw conflict(`Mutation journal record ${index + 1} is malformed; reconcile it outside MCP before reconnecting`);
      }
    }
    return ledger;
  }

  private constructor(private readonly path: string) {}

  async reconcile(idempotencyKey: string, requestDigest: string): Promise<MutationReconciliation> {
    const record = this.latest.get(sha256(idempotencyKey));
    if (!record) return { state: "missing" };
    if (record.requestDigest !== requestDigest) {
      throw conflict("Idempotency key was already used for a different editor mutation request");
    }
    return record.state === "completed"
      ? { state: "completed", result: record.result }
      : { state: "unknown" };
  }

  async begin(input: MutationLedgerKeyInput): Promise<void> {
    await this.append({
      schemaVersion: 1,
      state: "started",
      idempotencyKeySha256: sha256(input.idempotencyKey),
      requestDigest: Sha256Schema.parse(input.requestDigest),
      correlationId: input.correlationId,
      recordedAt: new Date().toISOString(),
    });
  }

  async complete(input: MutationLedgerCompleteInput): Promise<void> {
    await this.append({
      schemaVersion: 1,
      state: "completed",
      idempotencyKeySha256: sha256(input.idempotencyKey),
      requestDigest: Sha256Schema.parse(input.requestDigest),
      correlationId: input.correlationId,
      recordedAt: new Date().toISOString(),
      result: EditorMutationResultSchema.parse(input.result),
    });
  }

  private async append(record: LedgerRecord): Promise<void> {
    const write = this.tail.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const handle = await open(this.path, "a", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      this.remember(record);
    });
    this.tail = write.catch(() => undefined);
    await write;
  }

  private remember(record: LedgerRecord): void {
    this.latest.delete(record.idempotencyKeySha256);
    this.latest.set(record.idempotencyKeySha256, record);
    while (this.latest.size > MAX_KEYS) {
      const oldest = this.latest.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.latest.delete(oldest);
    }
  }
}
