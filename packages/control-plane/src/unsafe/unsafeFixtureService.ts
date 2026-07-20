import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rm, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { UnsafeFixtureJobReceiptSchema, UnsafeFixtureJobResultSchema, UnsafeFixtureOperationInputSchema, type UnsafeFixtureJobReceipt, type UnsafeFixtureJobResult, type UnsafeFixtureOperationInput } from "@godot-mcp/protocol";

import { GodotMcpException } from "../errors.js";
import { EvidenceStore } from "../evidence/evidenceStore.js";
import type { UnsafeActivation } from "./unsafeFixtureAuthority.js";
import type { UnsafeFixtureProcessHandle } from "./unsafeFixtureProcess.js";

interface UnsafeJob { token: string; sessionId: string; source: string; sourceSha256: string; sourceBytes: number; deadlineAt: number; state: UnsafeFixtureJobReceipt["state"]; controller: AbortController; process?: UnsafeFixtureProcessHandle; result?: UnsafeFixtureJobResult; }
const OUTPUT_CHUNK_BYTES = 512 * 1024;

export interface UnsafeFixtureServiceDependencies {
  activation: UnsafeActivation;
  sessionId(): string | null;
  launch(input: { projectRoot: string; scriptPath: string; isolationRoot: string }): Promise<UnsafeFixtureProcessHandle>;
  evidence?: EvidenceStore;
  now?: () => number;
}

function unsafeError(code: "NOT_ATTACHED" | "CONFLICT" | "STALE_HANDLE" | "CANCELLED" | "TIMEOUT", message: string): GodotMcpException {
  return new GodotMcpException({ code, message, retryable: false, correlationId: randomUUID(), partialEffects: false, rollback: "not_needed" });
}

async function ownedUnsafeDirectory(projectRoot: string, jobToken: string): Promise<string> {
  let current = projectRoot;
  for (const segment of [".godot", "evidence", "godot-mcp", "unsafe", jobToken]) {
    current = join(current, segment);
    let metadata = await lstat(current).catch(() => undefined);
    if (!metadata) { await mkdir(current, { mode: 0o700 }); metadata = await lstat(current); }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("Unsafe source directory must not contain symbolic links");
  }
  return current;
}

export class UnsafeFixtureService {
  private job: UnsafeJob | undefined;
  private runPromise: Promise<void> | undefined;
  private readonly now: () => number;
  private readonly evidence: EvidenceStore;

  constructor(private readonly dependencies: UnsafeFixtureServiceDependencies) {
    this.now = dependencies.now ?? (() => Date.now());
    this.evidence = dependencies.evidence ?? new EvidenceStore(dependencies.activation.copyRoot);
  }

  isActive(): boolean { return this.job !== undefined && ["queued", "running"].includes(this.job.state); }
  blocksExport(): boolean { return this.isActive() || this.job?.result?.cleanup === "failed"; }

  async initialize(): Promise<void> {
    const root = join(this.dependencies.activation.copyRoot, ".godot", "evidence", "godot-mcp", "unsafe");
    const metadata = await lstat(root).catch(() => undefined);
    if (!metadata) return;
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw unsafeError("CONFLICT", "Unsafe fixture residue root is invalid");
    if ((await readdir(root)).length > 0) throw unsafeError("CONFLICT", "Unsafe fixture crash residue requires explicit local cleanup before activation");
  }

  async execute(inputValue: UnsafeFixtureOperationInput, correlationId: string): Promise<{ data: unknown; evidence?: string[] }> {
    void correlationId;
    const input = UnsafeFixtureOperationInputSchema.parse(inputValue);
    if (input.operation === "execute_start") return { data: this.start(input.source, input.deadlineMs) };
    if (input.operation === "job_status") return { data: this.status(input.jobToken) };
    if (input.operation === "job_cancel") return { data: this.cancel(input.jobToken) };
    const result = this.result(input.jobToken); return { data: result, evidence: result.evidence };
  }

  start(source: string, deadlineMs: number): UnsafeFixtureJobReceipt {
    if (this.isActive()) throw unsafeError("CONFLICT", "An unsafe fixture job is already active");
    const sessionId = this.dependencies.sessionId();
    if (!sessionId) throw unsafeError("NOT_ATTACHED", "Unsafe fixture session is not attached");
    const now = this.now(); const leaseExpiry = Date.parse(this.dependencies.activation.expiresAt);
    if (now >= leaseExpiry || now + deadlineMs > leaseExpiry) throw unsafeError("TIMEOUT", "Unsafe fixture activation expires before this job deadline");
    const job: UnsafeJob = { token: `ujob_${randomBytes(32).toString("base64url")}`, sessionId, source, sourceSha256: createHash("sha256").update(source).digest("hex"), sourceBytes: Buffer.byteLength(source), deadlineAt: now + deadlineMs, state: "queued", controller: new AbortController() };
    this.job = job; this.runPromise = Promise.resolve().then(() => this.run(job)); void this.runPromise.catch(() => undefined);
    return this.receipt(job);
  }

  status(token: string): UnsafeFixtureJobReceipt { return this.receipt(this.requireJob(token)); }
  cancel(token: string): UnsafeFixtureJobReceipt { const job = this.requireJob(token); if (this.isActive()) job.controller.abort(unsafeError("CANCELLED", "Unsafe fixture job cancelled")); return this.receipt(job); }
  result(token: string): UnsafeFixtureJobResult { const job = this.requireJob(token); if (!job.result) throw unsafeError("CONFLICT", "Unsafe fixture result is not terminal"); return job.result; }

  async close(): Promise<void> { if (!this.job) return; if (this.isActive()) { this.job.controller.abort(unsafeError("CANCELLED", "Unsafe fixture service closed")); await this.job.process?.stop().catch(() => undefined); } await this.runPromise; }

  private requireJob(token: string): UnsafeJob { if (!this.job || this.job.token !== token || this.dependencies.sessionId() !== this.job.sessionId) throw unsafeError("STALE_HANDLE", "Unsafe fixture job token is stale"); return this.job; }
  private receipt(job: UnsafeJob): UnsafeFixtureJobReceipt { return UnsafeFixtureJobReceiptSchema.parse({ jobToken: job.token, state: job.state, unsafe: true, sandboxed: false, expiresAt: this.dependencies.activation.expiresAt }); }

  private async run(job: UnsafeJob): Promise<void> {
    job.state = "running"; let exitCode: number | null = null; let terminal: "completed" | "failed" | "cancelled" = "failed"; let cleanup: "succeeded" | "failed" = "succeeded"; const evidence: string[] = [];
    let root = join(this.dependencies.activation.copyRoot, ".godot", "evidence", "godot-mcp", "unsafe", job.token);
    const script = join(root, "script.gd");
    try {
      if (job.controller.signal.aborted) throw job.controller.signal.reason;
      root = await ownedUnsafeDirectory(this.dependencies.activation.copyRoot, job.token);
      const handle = await open(script, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(job.source, "utf8"); } finally { await handle.close(); }
      job.source = "";
      if (job.controller.signal.aborted) throw job.controller.signal.reason;
      job.process = await this.dependencies.launch({ projectRoot: this.dependencies.activation.copyRoot, scriptPath: script, isolationRoot: join(root, "isolation") });
      exitCode = await this.interruptible(job, job.process.wait());
      terminal = exitCode === 0 && !job.process.outputExceeded() ? "completed" : "failed";
    } catch {
      await job.process?.stop().catch(() => undefined);
      terminal = job.controller.signal.aborted ? "cancelled" : "failed";
    } finally {
      const output = job.process?.diagnostics() ?? Buffer.alloc(0);
      const chunkCount = Math.max(1, Math.ceil(output.byteLength / OUTPUT_CHUNK_BYTES));
      for (let index = 0; index < chunkCount; index += 1) {
        const chunk = output.subarray(index * OUTPUT_CHUNK_BYTES, (index + 1) * OUTPUT_CHUNK_BYTES);
        const stored = await this.evidence.putJson(job.sessionId, { outputBase64: chunk.toString("base64"), encoding: "base64", chunkIndex: index, chunkCount, outputExceeded: job.process?.outputExceeded() ?? false, state: terminal, exitCode, unsafe: true, sandboxed: false }, { kind: "unsafe_fixture_output" }).catch(() => undefined);
        if (stored) evidence.push(stored.observationUri);
      }
      const cleanupErrors: unknown[] = [];
      await unlink(script).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") cleanupErrors.push(error); });
      await rm(join(root, "isolation"), { recursive: true, force: true }).catch((error) => cleanupErrors.push(error));
      await rmdir(root).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") cleanupErrors.push(error); });
      if (cleanupErrors.length > 0) cleanup = "failed";
      job.state = terminal;
      job.result = UnsafeFixtureJobResultSchema.parse({ ...this.receipt(job), state: terminal, exitCode, sourceSha256: job.sourceSha256, sourceBytes: job.sourceBytes, evidence, cleanup });
    }
  }

  private async interruptible(job: UnsafeJob, operation: Promise<number>): Promise<number> {
    const remaining = job.deadlineAt - this.now(); let timer: ReturnType<typeof setTimeout> | undefined; let listener: (() => void) | undefined;
    const interruption = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(unsafeError("TIMEOUT", "Unsafe fixture deadline expired")), remaining); listener = () => reject(job.controller.signal.reason); job.controller.signal.addEventListener("abort", listener, { once: true }); });
    try { return await Promise.race([operation, interruption]); } finally { if (timer) clearTimeout(timer); if (listener) job.controller.signal.removeEventListener("abort", listener); }
  }
}
