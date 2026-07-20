import { createHash, randomUUID } from "node:crypto";
import {
  ProjectMutationResultSchema,
  ProjectOperationInputSchema,
  canonicalFloat64Le,
  canonicalJson,
  type ProjectMutationResult,
  type ProjectOperationInput,
} from "@godot-mcp/protocol";
import { z } from "zod";

import { GodotMcpException } from "../errors.js";
import { appendSecureJournal, readSecureJournal } from "./secureJournalFile.js";

type ProjectMutationInput = Extract<ProjectOperationInput, { operation: "settings_apply" | "plugin_set" }>;
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;

const RecordSchema = z.discriminatedUnion("state", [
  z.object({ schemaVersion: z.literal(1), state: z.literal("started"), keySha256: Sha256Schema, requestDigest: Sha256Schema, recordedAt: z.string().datetime() }).strict(),
  z.object({ schemaVersion: z.literal(1), state: z.literal("completed"), keySha256: Sha256Schema, requestDigest: Sha256Schema, recordedAt: z.string().datetime(), result: ProjectMutationResultSchema }).strict(),
]);
type JournalRecord = z.infer<typeof RecordSchema>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function settingValueSha256(value: string | number | boolean | null): string {
  const canonical = typeof value === "number" && !Number.isSafeInteger(value)
    ? canonicalJson({ $godotMcpFloat64Le: canonicalFloat64Le(value) })
    : canonicalJson(value);
  return sha256(canonical);
}

function conflict(message: string, partialEffects = false): GodotMcpException {
  return new GodotMcpException({
    code: "CONFLICT",
    message,
    retryable: false,
    correlationId: randomUUID(),
    partialEffects,
    rollback: partialEffects ? "not_attempted" : "not_needed",
  });
}

export class ProjectMutationJournal {
  private readonly latest = new Map<string, JournalRecord>();
  private tail: Promise<unknown> = Promise.resolve();

  static async open(path: string): Promise<ProjectMutationJournal> {
    const journal = new ProjectMutationJournal(path);
    try {
      const text = await readSecureJournal(path, MAX_JOURNAL_BYTES);
      if (text === null) return journal;
      for (const [index, line] of text.split("\n").entries()) {
        if (!line) continue;
        try {
          journal.remember(RecordSchema.parse(JSON.parse(line) as unknown));
        } catch {
          throw conflict(`Project mutation journal record ${index + 1} is malformed`);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return journal;
  }

  private constructor(private readonly path: string) {}

  reconcile(key: string, requestDigest: string): { state: "missing" | "unknown" } | { state: "completed"; result: ProjectMutationResult } {
    const record = this.latest.get(sha256(key));
    if (!record) return { state: "missing" };
    if (record.requestDigest !== requestDigest) throw conflict("Idempotency key was already used for another project mutation");
    return record.state === "completed" ? { state: "completed", result: record.result } : { state: "unknown" };
  }

  async begin(key: string, requestDigest: string): Promise<void> {
    await this.append({ schemaVersion: 1, state: "started", keySha256: sha256(key), requestDigest, recordedAt: new Date().toISOString() });
  }

  async complete(key: string, requestDigest: string, result: ProjectMutationResult): Promise<void> {
    await this.append({ schemaVersion: 1, state: "completed", keySha256: sha256(key), requestDigest, recordedAt: new Date().toISOString(), result });
  }

  private async append(record: JournalRecord): Promise<void> {
    const write = this.tail.then(async () => {
      await appendSecureJournal(this.path, `${JSON.stringify(record)}\n`);
      this.remember(record);
    });
    this.tail = write.catch(() => undefined);
    await write;
  }

  private remember(record: JournalRecord): void {
    this.latest.delete(record.keySha256);
    this.latest.set(record.keySha256, record);
    while (this.latest.size > 256) this.latest.delete(this.latest.keys().next().value as string);
  }
}

export interface ProjectMutationBridge {
  request(method: "project.operation", params: unknown, options: { timeoutMs: number; maxResponseBytes: number; correlationId: string }): Promise<{ data: unknown }>;
}

export class ProjectMutationService {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly bridge: () => ProjectMutationBridge | null, private readonly journal: ProjectMutationJournal) {}

  async execute(rawInput: ProjectMutationInput, correlationId: string): Promise<ProjectMutationResult> {
    const run = this.tail.then(() => this.executeExclusive(rawInput, correlationId));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async executeExclusive(rawInput: ProjectMutationInput, correlationId: string): Promise<ProjectMutationResult> {
    const parsed = ProjectOperationInputSchema.parse(rawInput);
    if (parsed.operation !== "settings_apply" && parsed.operation !== "plugin_set") throw conflict("Operation is not a project mutation");
    const input = parsed;
    const requestDigest = sha256(JSON.stringify(input));
    const reconciliation = this.journal.reconcile(input.idempotencyKey, requestDigest);
    if (reconciliation.state === "completed") return reconciliation.result;
    if (reconciliation.state === "unknown") throw conflict("A prior project mutation has an unknown outcome; reconcile project state before using a new key", true);
    const bridge = this.bridge();
    if (!bridge) {
      throw new GodotMcpException({ code: "NOT_ATTACHED", message: "Godot editor addon is not attached", retryable: true, correlationId, partialEffects: false, rollback: "not_needed" });
    }
    await this.journal.begin(input.idempotencyKey, requestDigest);
    const response = await bridge.request("project.operation", input, { timeoutMs: 30_000, maxResponseBytes: 256 * 1024, correlationId });
    const result = ProjectMutationResultSchema.parse(response.data);
    if (!receiptMatchesRequest(input, result)) {
      throw conflict("Godot returned a mismatched project mutation receipt", true);
    }
    await this.journal.complete(input.idempotencyKey, requestDigest, result);
    return result;
  }
}

function receiptMatchesRequest(input: ProjectMutationInput, result: ProjectMutationResult): boolean {
  if (result.operation !== input.operation) return false;
  if (result.operation === "plugin_set" && input.operation === "plugin_set") {
    return result.pluginSha256 === sha256(input.pluginPath) && result.enabled === input.enabled;
  }
  if (result.operation !== "settings_apply" || input.operation !== "settings_apply" || result.changes.length !== input.changes.length) return false;
  return result.changes.every((receipt, index) => {
    const change = input.changes[index];
    if (!change) return false;
    if (receipt.settingNameSha256 !== sha256(change.name) || receipt.postimageSha256 !== settingValueSha256(change.value)) return false;
    return change.expectedValue === undefined || receipt.preimageSha256 === settingValueSha256(change.expectedValue);
  });
}
