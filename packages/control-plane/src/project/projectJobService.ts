import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  ProjectJobReceiptSchema,
  ProjectOperationInputSchema,
  ProjectOperationResultSchema,
  type ProjectJobReceipt,
  type ProjectOperationInput,
  type ProjectOperationResult,
} from "@godot-mcp/protocol";

import { GodotMcpException } from "../errors.js";
import { EvidenceStore } from "../evidence/evidenceStore.js";
import type { ArtifactStore } from "./artifactStore.js";
import type { ProjectJobJournal } from "./projectJobJournal.js";
import type { ProjectProcessInput } from "./projectProcess.js";

type ProjectJobStartInput = Extract<ProjectOperationInput, {
  operation: "import_start" | "run_start" | "build_start" | "export_start";
}>;
type JobOperation = ProjectJobReceipt["operation"];
type JobState = ProjectJobReceipt["state"];

export interface ProjectJobProcess {
  readonly pid: number;
  readonly fingerprint: string;
  wait(): Promise<number>;
  stop(graceMs?: number): Promise<void>;
  diagnostics?(): string;
}

export interface ProjectJobServiceDependencies {
  projectId: string;
  projectRoot: string;
  sessionId(): string | null;
  artifacts: ArtifactStore;
  launch(input: ProjectProcessInput): Promise<ProjectJobProcess>;
  reimport?(resourcePaths: string[]): Promise<void>;
  evidence?: EvidenceStore;
  now?: () => number;
  journal?: ProjectJobJournal;
  recoverProcess?(pid: number, fingerprint: string): Promise<"stopped" | "missing" | "ambiguous">;
  preflight?(input: ProjectJobStartInput): Promise<void>;
  conflictReason?(input: ProjectJobStartInput): string | null;
}

interface ProjectJob {
  token: string;
  sessionId: string;
  input: ProjectJobStartInput;
  operation: JobOperation;
  state: JobState;
  phase: ProjectJobReceipt["phase"];
  progressMillionths: number;
  cancellationSafe: boolean;
  deadlineAtMs: number;
  controller: AbortController;
  process?: ProjectJobProcess;
  result?: ProjectOperationResult;
}

function jobError(code: "NOT_ATTACHED" | "STALE_HANDLE" | "CONFLICT" | "CANCELLED" | "TIMEOUT" | "GODOT_RUNTIME_ERROR", message: string): GodotMcpException {
  return new GodotMcpException({
    code,
    message,
    retryable: false,
    correlationId: randomUUID(),
    partialEffects: false,
    rollback: "not_needed",
  });
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "GODOT_RUNTIME_ERROR";
}

function operationFor(input: ProjectJobStartInput): JobOperation {
  if (input.operation === "import_start") return input.kind === "full" ? "import" : "reimport";
  if (input.operation === "run_start") return "run";
  if (input.operation === "build_start") return "build";
  return "export";
}

export class ProjectJobService {
  private job: ProjectJob | undefined;
  private runPromise: Promise<void> | undefined;
  private readonly evidence: EvidenceStore;
  private readonly now: () => number;

  constructor(private readonly dependencies: ProjectJobServiceDependencies) {
    this.evidence = dependencies.evidence ?? new EvidenceStore(dependencies.projectRoot);
    this.now = dependencies.now ?? (() => Date.now());
  }

  async recover(): Promise<void> {
    if (!this.dependencies.journal) return;
    for (const record of this.dependencies.journal.nonterminal(this.dependencies.projectId)) {
      const recovery = record.pid !== undefined && record.fingerprint !== undefined && this.dependencies.recoverProcess
        ? await this.dependencies.recoverProcess(record.pid, record.fingerprint)
        : "ambiguous";
      let artifactRecovery: "not_applicable" | "clean" | "rejected" | "absent" = "not_applicable";
      if (record.operation === "export" && record.artifactName) {
        try {
          await this.dependencies.artifacts.finalize(record.jobToken, record.artifactName);
          artifactRecovery = "clean";
        } catch (error) {
          artifactRecovery = errorCode(error) === "PRECONDITION_FAILED" ? "absent" : "rejected";
        }
      }
      await this.evidence.putJson(record.sessionId, { operation: record.operation, recovery, artifactRecovery }, { kind: "project_job_recovery" }).catch(() => undefined);
      await this.dependencies.journal.append({
        projectId: record.projectId,
        jobToken: record.jobToken,
        sessionId: record.sessionId,
        operation: record.operation,
        state: "failed",
        ...(record.pid === undefined ? {} : { pid: record.pid, fingerprint: record.fingerprint! }),
        ...(record.artifactName === undefined ? {} : { artifactName: record.artifactName }),
        recovery,
        artifactRecovery,
      });
    }
  }

  start(rawInput: ProjectJobStartInput): ProjectJobReceipt {
    if (this.job && (this.job.state === "queued" || this.job.state === "running")) throw jobError("CONFLICT", "A project operation job is already active");
    const sessionId = this.dependencies.sessionId();
    if (!sessionId) throw jobError("NOT_ATTACHED", "Godot editor addon is not attached");
    const parsed = ProjectOperationInputSchema.parse(rawInput);
    if (!["import_start", "run_start", "build_start", "export_start"].includes(parsed.operation)) throw jobError("CONFLICT", "Operation does not start a project job");
    const input = parsed as ProjectJobStartInput;
    const conflict = this.dependencies.conflictReason?.(input);
    if (conflict) throw jobError("CONFLICT", conflict);
    const job: ProjectJob = {
      token: `pjob_${randomBytes(32).toString("base64url")}`,
      sessionId,
      input,
      operation: operationFor(input),
      state: "queued",
      phase: "validating",
      progressMillionths: 0,
      cancellationSafe: true,
      deadlineAtMs: Math.floor(this.now()) + input.deadlineMs,
      controller: new AbortController(),
    };
    this.job = job;
    this.runPromise = Promise.resolve().then(() => this.run(job));
    void this.runPromise.catch(() => undefined);
    return this.receipt(job);
  }

  status(jobToken: string): ProjectJobReceipt {
    return this.receipt(this.requireJob(jobToken));
  }

  cancel(jobToken: string): ProjectJobReceipt {
    const job = this.requireJob(jobToken);
    if (job.state === "queued" || job.state === "running") job.controller.abort(jobError("CANCELLED", "Project operation was cancelled"));
    return this.receipt(job);
  }

  result(jobToken: string): ProjectOperationResult {
    const job = this.requireJob(jobToken);
    if (!job.result) throw jobError("CONFLICT", "Project operation result is not terminal");
    return ProjectOperationResultSchema.parse(job.result);
  }

  async close(): Promise<void> {
    const job = this.job;
    if (!job) return;
    if (["queued", "running"].includes(job.state)) {
      job.controller.abort(jobError("CANCELLED", "Project job service closed"));
      await job.process?.stop().catch(() => undefined);
    }
    await this.runPromise;
  }

  private requireJob(jobToken: string): ProjectJob {
    const job = this.job;
    if (!job || job.token !== jobToken || this.dependencies.sessionId() !== job.sessionId) throw jobError("STALE_HANDLE", "Project job token is stale or belongs to another session");
    return job;
  }

  private receipt(job: ProjectJob): ProjectJobReceipt {
    return ProjectJobReceiptSchema.parse({
      jobToken: job.token,
      operation: job.operation,
      state: job.state,
      phase: job.phase,
      progressMillionths: job.progressMillionths,
      cancellationSafe: job.cancellationSafe,
    });
  }

  private assertActive(job: ProjectJob): void {
    if (job.controller.signal.aborted) throw job.controller.signal.reason ?? jobError("CANCELLED", "Project operation was cancelled");
    if (Math.floor(this.now()) >= job.deadlineAtMs) throw jobError("TIMEOUT", "Project operation deadline expired");
  }

  private async boundary<T>(job: ProjectJob, promiseFactory: () => Promise<T>): Promise<T> {
    this.assertActive(job);
    const remaining = job.deadlineAtMs - Math.floor(this.now());
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const operation = promiseFactory();
    operation.catch(() => undefined);
    const interruption = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(jobError("TIMEOUT", "Project operation deadline expired")), remaining);
      abortListener = () => reject(job.controller.signal.reason ?? jobError("CANCELLED", "Project operation was cancelled"));
      job.controller.signal.addEventListener("abort", abortListener, { once: true });
    });
    try {
      return await Promise.race([operation, interruption]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abortListener) job.controller.signal.removeEventListener("abort", abortListener);
    }
  }

  private async nonInterruptibleBoundary<T>(job: ProjectJob, promiseFactory: () => Promise<T>): Promise<T> {
    this.assertActive(job);
    const result = await promiseFactory();
    this.assertActive(job);
    return result;
  }

  private async run(job: ProjectJob): Promise<void> {
    if (this.job !== job) return;
    job.state = "running";
    job.phase = "preparing";
    let exitCode: number | null = null;
    let terminalState: "completed" | "failed" | "cancelled" = "failed";
    let artifact: ProjectOperationResult["artifact"];
    try {
      await this.record(job);
      await this.dependencies.preflight?.(job.input);
      this.assertActive(job);
      if (job.operation === "reimport") {
        if (!this.dependencies.reimport) throw jobError("GODOT_RUNTIME_ERROR", "Selective reimport transport is unavailable");
        job.phase = "executing";
        job.progressMillionths = 250_000;
        job.cancellationSafe = false;
        await this.nonInterruptibleBoundary(job, () => this.dependencies.reimport!((job.input as Extract<ProjectJobStartInput, { operation: "import_start" }>).resourcePaths!));
        job.cancellationSafe = true;
        job.progressMillionths = 900_000;
      } else {
        let processInput: ProjectProcessInput;
        if (job.input.operation === "import_start") processInput = { operation: "import", projectRoot: this.dependencies.projectRoot };
        else if (job.input.operation === "run_start") processInput = {
          operation: "run",
          projectRoot: this.dependencies.projectRoot,
          headless: job.input.headless,
          ...(job.input.scenePath ? { scenePath: job.input.scenePath } : {}),
        };
        else if (job.input.operation === "build_start") processInput = { operation: "build", projectRoot: this.dependencies.projectRoot };
        else {
          const allocated = await this.dependencies.artifacts.allocate(job.token, job.input.artifactName);
          const extension = job.input.mode === "pack" ? "pck" : "zip";
          processInput = {
            operation: "export",
            projectRoot: this.dependencies.projectRoot,
            artifactRoot: allocated.path,
            mode: job.input.mode,
            preset: job.input.preset,
            outputPath: join(allocated.path, `${job.input.artifactName}.${extension}`),
          };
        }
        this.assertActive(job);
        job.process = await this.dependencies.launch(processInput);
        await this.record(job);
        job.phase = "executing";
        job.progressMillionths = 250_000;
        exitCode = await this.boundary(job, () => job.process!.wait());
        if (exitCode !== 0) throw jobError("GODOT_RUNTIME_ERROR", `Godot project operation exited with code ${exitCode}`);
        job.progressMillionths = 800_000;
        if (job.input.operation === "export_start") {
          job.phase = "scanning";
          artifact = await this.dependencies.artifacts.finalize(job.token, job.input.artifactName);
        }
      }
      terminalState = "completed";
    } catch (error) {
      if (job.process && (errorCode(error) === "CANCELLED" || errorCode(error) === "TIMEOUT")) await job.process.stop().catch(() => undefined);
      terminalState = errorCode(error) === "CANCELLED" ? "cancelled" : "failed";
    } finally {
      job.cancellationSafe = true;
      job.phase = "finalizing";
      const evidence: string[] = [];
      try {
        const stored = await this.evidence.putJson(job.sessionId, {
          operation: job.operation,
          exitCode,
          output: job.process?.diagnostics?.() ?? "",
          state: terminalState,
        }, { kind: "project_job_output" });
        evidence.push(stored.observationUri);
      } catch {}
      job.progressMillionths = 1_000_000;
      job.phase = "terminal";
      job.state = terminalState;
      job.result = ProjectOperationResultSchema.parse({
        ...this.receipt(job),
        state: terminalState,
        phase: "terminal",
        exitCode,
        partialEffects: false,
        rollback: "not_needed",
        evidence,
        ...(artifact ? { artifact } : {}),
      });
      await this.record(job);
    }
  }

  private async record(job: ProjectJob): Promise<void> {
    if (!this.dependencies.journal) return;
    await this.dependencies.journal.append({
      projectId: this.dependencies.projectId,
      jobToken: job.token,
      sessionId: job.sessionId,
      operation: job.operation,
      state: job.state,
      ...(job.process ? { pid: job.process.pid, fingerprint: job.process.fingerprint } : {}),
      ...(job.input.operation === "export_start" ? { artifactName: job.input.artifactName } : {}),
    });
  }
}
