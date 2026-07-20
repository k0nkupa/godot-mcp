import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  canonicalJson,
  RuntimeCaptureFrameMetadataSchema,
  RuntimeLaunchPinsSchema,
  ScenarioDeclarationSchema,
  ScenarioJobReceiptSchema,
  ScenarioReportSchema,
  VisualComparisonResultSchema,
  type InputOperationInput,
  type RuntimeCaptureFrameMetadata,
  type RuntimeCaptureInput,
  type RuntimeHandle,
  type RuntimeLaunchPins,
  type RuntimeOperationInput,
  type ScenarioDeclaration,
  type ScenarioJobReceipt,
  type ScenarioReport,
  type VisualComparisonResult,
} from "@godot-mcp/protocol";

import { GodotMcpException } from "../errors.js";
import type { EvidenceStore } from "../evidence/evidenceStore.js";
import { comparePng } from "./pngComparison.js";

export interface ScenarioFrame {
  data: Uint8Array;
  metadata: RuntimeCaptureFrameMetadata;
}

export interface ScenarioRuntime {
  launch(input: { scenePath: string; startupTimeoutMs: number; pins: RuntimeLaunchPins }): Promise<{ handle: RuntimeHandle; root: unknown }>;
  execute(input: Exclude<RuntimeOperationInput, { operation: "launch" }>): Promise<unknown>;
  input(input: InputOperationInput): Promise<unknown>;
  capture(input: RuntimeCaptureInput): Promise<{ frames: ScenarioFrame[] }>;
}

export interface ScenarioServiceDependencies {
  projectId: string;
  sessionId(): string | null;
  runtime: ScenarioRuntime;
  evidence: EvidenceStore;
  now?: () => number;
}

type JobState = "queued" | "running" | "completed" | "failed" | "cancelled";

interface StoredFrame extends ScenarioFrame {
  observationUri: `godot-mcp://evidence/${string}`;
}

interface ScenarioJob {
  token: string;
  sessionId: string;
  scenario: ScenarioDeclaration;
  state: JobState;
  completedSteps: number;
  controller: AbortController;
  startedAtMs: number;
  deadlineAtMs: number;
  report?: ScenarioReport;
}

function scenarioError(
  code: "NOT_ATTACHED" | "STALE_HANDLE" | "CONFLICT" | "CANCELLED" | "TIMEOUT" | "ASSERTION_FAILED" | "GODOT_RUNTIME_ERROR",
  message: string,
  evidence: `godot-mcp://evidence/${string}`[] = [],
): GodotMcpException & { evidence?: `godot-mcp://evidence/${string}`[] } {
  const error = new GodotMcpException({
    code,
    message,
    retryable: false,
    correlationId: randomUUID(),
    partialEffects: false,
    rollback: "not_needed",
  });
  return evidence.length === 0 ? error : Object.assign(error, { evidence: [...evidence] });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === "string" ? error.code : "GODOT_RUNTIME_ERROR";
}

function errorEvidence(error: unknown): `godot-mcp://evidence/${string}`[] {
  if (!isRecord(error) || !Array.isArray(error.evidence)) return [];
  return error.evidence.filter((entry): entry is `godot-mcp://evidence/${string}` =>
    typeof entry === "string" && entry.startsWith("godot-mcp://evidence/"));
}

function rethrowIfInterrupted(error: unknown): void {
  if (errorCode(error) === "CANCELLED" || errorCode(error) === "TIMEOUT") throw error;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function wildcardMatches(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
  return new RegExp(`^${escaped}$`, "u").test(value);
}

export class ScenarioService {
  private job: ScenarioJob | undefined;
  private readonly now: () => number;

  constructor(private readonly dependencies: ScenarioServiceDependencies) {
    this.now = dependencies.now ?? (() => Date.now());
  }

  hasActiveJob(): boolean {
    return this.job !== undefined && (this.job.state === "queued" || this.job.state === "running");
  }

  start(input: unknown): ScenarioJobReceipt {
    if (this.job && (this.job.state === "queued" || this.job.state === "running")) {
      throw scenarioError("CONFLICT", "A visual scenario job is already active");
    }
    const sessionId = this.dependencies.sessionId();
    if (!sessionId) throw scenarioError("NOT_ATTACHED", "Godot editor addon is not attached");
    const scenario = ScenarioDeclarationSchema.parse(input);
    const token = `vsj_${randomBytes(32).toString("base64url")}`;
    const startedAtMs = Math.floor(this.now());
    const job: ScenarioJob = {
      token,
      sessionId,
      scenario,
      state: "queued",
      completedSteps: 0,
      controller: new AbortController(),
      startedAtMs,
      deadlineAtMs: startedAtMs + scenario.deadlineMs,
    };
    this.job = job;
    queueMicrotask(() => void this.run(job));
    return this.receipt(job);
  }

  status(jobToken: string): ScenarioJobReceipt {
    return this.receipt(this.requireJob(jobToken));
  }

  cancel(jobToken: string): ScenarioJobReceipt {
    const job = this.requireJob(jobToken);
    if (job.state === "queued" || job.state === "running") {
      job.controller.abort(scenarioError("CANCELLED", "Visual scenario was cancelled"));
    }
    return this.receipt(job);
  }

  result(jobToken: string): ScenarioReport {
    const job = this.requireJob(jobToken);
    if (!job.report) throw scenarioError("CONFLICT", "Visual scenario result is not terminal");
    return ScenarioReportSchema.parse(job.report);
  }

  async close(): Promise<void> {
    const job = this.job;
    if (!job || !["queued", "running"].includes(job.state)) return;
    job.controller.abort(scenarioError("CANCELLED", "Visual scenario service closed"));
    for (let attempt = 0; attempt < 200 && !job.report; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }

  private requireJob(jobToken: string): ScenarioJob {
    const job = this.job;
    if (!job || job.token !== jobToken || this.dependencies.sessionId() !== job.sessionId) {
      throw scenarioError("STALE_HANDLE", "Visual scenario job token is stale or belongs to another session");
    }
    return job;
  }

  private receipt(job: ScenarioJob): ScenarioJobReceipt {
    return ScenarioJobReceiptSchema.parse({
      jobToken: job.token,
      state: job.state,
      completedSteps: job.completedSteps,
      totalSteps: job.scenario.steps.length,
    });
  }

  private async run(job: ScenarioJob): Promise<void> {
    if (this.job !== job) return;
    job.state = "running";
    let handle: RuntimeHandle | undefined;
    let observedGodotVersion: string | undefined;
    let observedPins: RuntimeLaunchPins | undefined;
    let paused = false;
    let terminalState: "completed" | "failed" | "cancelled" = "failed";
    let failedStepIndex: number | null = null;
    let cleanup: "succeeded" | "failed" | "not_needed" = "not_needed";
    const stepReceipts: ScenarioReport["steps"] = [];
    const captures = new Map<string, StoredFrame[]>();
    try {
      this.assertJobActive(job);
      const launched = await this.boundary(job, this.dependencies.runtime.launch({
        scenePath: job.scenario.scenePath,
        startupTimeoutMs: job.scenario.startupTimeoutMs,
        pins: job.scenario.pins,
      }));
      handle = launched.handle;
      if (isRecord(launched.root) && typeof launched.root.godotVersion === "string") observedGodotVersion = launched.root.godotVersion;
      if (isRecord(launched.root)) {
        const parsedObservedPins = RuntimeLaunchPinsSchema.safeParse(launched.root.observedPins);
        if (parsedObservedPins.success) observedPins = parsedObservedPins.data;
      }
      for (const [index, step] of job.scenario.steps.entries()) {
        const startedMonotonicMs = Math.max(0, Math.floor(this.now() - job.startedAtMs));
        try {
          const outcome = await this.runStep(job, handle, step, captures, paused);
          paused = outcome.paused;
          const finishedMonotonicMs = Math.max(startedMonotonicMs, Math.floor(this.now() - job.startedAtMs));
          stepReceipts.push({
            index,
            kind: step.kind,
            state: "completed",
            startedMonotonicMs,
            finishedMonotonicMs,
            summary: outcome.summary,
            evidence: outcome.evidence,
          });
          job.completedSteps += 1;
        } catch (error) {
          failedStepIndex = index;
          const cancelled = errorCode(error) === "CANCELLED";
          const finishedMonotonicMs = Math.max(startedMonotonicMs, Math.floor(this.now() - job.startedAtMs));
          stepReceipts.push({
            index,
            kind: step.kind,
            state: cancelled ? "cancelled" : "failed",
            startedMonotonicMs,
            finishedMonotonicMs,
            summary: { errorCode: errorCode(error) },
            evidence: errorEvidence(error),
          });
          throw error;
        }
      }
      terminalState = "completed";
    } catch (error) {
      terminalState = errorCode(error) === "CANCELLED" ? "cancelled" : "failed";
    } finally {
      if (handle) {
        try {
          await this.dependencies.runtime.execute({ operation: "stop", handle });
          cleanup = "succeeded";
        } catch {
          cleanup = "failed";
          terminalState = "failed";
        }
      }
      const reportWithoutDigest = {
        schemaVersion: 1 as const,
        comparisonContractVersion: 1 as const,
        jobToken: job.token,
        scenarioName: job.scenario.name,
        projectId: this.dependencies.projectId,
        scenePath: job.scenario.scenePath,
        ...(handle ? { handle } : {}),
        pins: job.scenario.pins,
        ...(observedGodotVersion ? { observedGodotVersion } : {}),
        ...(observedPins ? { observedPins } : {}),
        state: terminalState,
        failedStepIndex,
        steps: stepReceipts,
        durationMs: Math.min(job.scenario.deadlineMs, Math.max(0, Math.floor(this.now() - job.startedAtMs))),
        cleanup,
      };
      let report = ScenarioReportSchema.parse({ ...reportWithoutDigest, reportSha256: digest(reportWithoutDigest) });
      try {
        const evidence = await this.dependencies.evidence.putJson(job.sessionId, report, { kind: "scenario_report" });
        report = ScenarioReportSchema.parse({ ...report, reportObservationUri: evidence.observationUri });
      } catch {
        if (report.state === "completed") {
          const failedReportWithoutDigest = { ...reportWithoutDigest, state: "failed" as const };
          report = ScenarioReportSchema.parse({
            ...failedReportWithoutDigest,
            reportSha256: digest(failedReportWithoutDigest),
          });
          terminalState = "failed";
        }
      }
      job.report = report;
      job.state = terminalState;
    }
  }

  private async runStep(
    job: ScenarioJob,
    handle: RuntimeHandle,
    step: ScenarioDeclaration["steps"][number],
    captures: Map<string, StoredFrame[]>,
    paused: boolean,
  ): Promise<{ paused: boolean; summary: Record<string, unknown>; evidence: `godot-mcp://evidence/${string}`[] }> {
    this.assertJobActive(job);
    switch (step.kind) {
      case "wait":
        await this.boundary(job, this.dependencies.runtime.execute({ operation: "wait", handle, timeoutMs: step.timeoutMs, condition: step.condition }));
        return { paused, summary: { satisfied: true }, evidence: [] };
      case "assert":
        await this.assertRuntime(job, handle, step.assertion);
        return { paused, summary: { passed: true, assertion: step.assertion.type }, evidence: [] };
      case "control": {
        const input: Exclude<RuntimeOperationInput, { operation: "launch" }> = step.action === "step"
          ? { operation: "step", handle, frames: step.frames! }
          : { operation: step.action, handle };
        await this.boundary(job, this.dependencies.runtime.execute(input));
        return { paused: step.action === "pause" || (step.action === "step" && paused), summary: { action: step.action }, evidence: [] };
      }
      case "input": {
        if (step.mode === "deterministic" && !paused) throw scenarioError("ASSERTION_FAILED", "Deterministic input requires a paused runtime");
        const input: InputOperationInput = step.mode === "deterministic"
          ? { operation: "replay", handle, mode: "deterministic", timeoutMs: step.timeoutMs, trace: step.trace }
          : { operation: "sequence", handle, mode: "realtime", timeoutMs: step.timeoutMs, events: step.trace.events };
        await this.boundary(job, this.dependencies.runtime.input(input));
        return { paused, summary: { mode: step.mode, eventCount: step.trace.events.length }, evidence: [] };
      }
      case "capture": {
        const captured = await this.boundary(job, this.dependencies.runtime.capture({
          handle,
          maxWidth: step.maxWidth,
          maxHeight: step.maxHeight,
          frameCount: step.frameCount,
          intervalFrames: step.intervalFrames,
          advancePaused: step.advancePaused,
        }));
        if (captured.frames.length !== step.frameCount) throw scenarioError("GODOT_RUNTIME_ERROR", "Scenario capture returned an unexpected frame count");
        const frames: StoredFrame[] = [];
        for (const [index, candidate] of captured.frames.entries()) {
          const metadata = RuntimeCaptureFrameMetadataSchema.parse(candidate.metadata);
          const sha256 = createHash("sha256").update(candidate.data).digest("hex");
          if (metadata.frameIndex !== index || metadata.byteLength !== candidate.data.byteLength || metadata.sha256 !== sha256) {
            throw scenarioError("GODOT_RUNTIME_ERROR", "Scenario capture metadata conflicts with PNG evidence");
          }
          const stored = await this.boundary(job, this.dependencies.evidence.putPng(job.sessionId, candidate.data, {
            source: "runtime",
            viewport: "runtime",
            width: metadata.width,
            height: metadata.height,
            runId: handle.runId,
            generation: handle.generation,
            frameIndex: index,
          }));
          frames.push({ data: candidate.data, metadata, observationUri: stored.observationUri });
        }
        captures.set(step.label, frames);
        return { paused, summary: { label: step.label, frameCount: frames.length }, evidence: frames.map((frame) => frame.observationUri) };
      }
      case "compare": {
        const frame = captures.get(step.captureLabel)?.[step.frameIndex];
        if (!frame) throw scenarioError("ASSERTION_FAILED", "Scenario comparison capture is unavailable");
        const baseline = await this.boundary(job, this.dependencies.evidence.readPngBaselineData(step.baselineName));
        const compared = comparePng({ baseline: baseline.data, current: frame.data, settings: step.settings });
        const evidence: `godot-mcp://evidence/${string}`[] = [frame.observationUri];
        let result: VisualComparisonResult = compared.result;
        if (compared.diffPng) {
          const storedDiff = await this.boundary(job, this.dependencies.evidence.putPng(job.sessionId, compared.diffPng, {
            source: "runtime",
            viewport: "runtime",
            width: frame.metadata.width,
            height: frame.metadata.height,
            runId: handle.runId,
            generation: handle.generation,
            frameIndex: step.frameIndex,
          }));
          evidence.push(storedDiff.observationUri);
          result = VisualComparisonResultSchema.parse({ ...result, diffObservationUri: storedDiff.observationUri });
        }
        const report = await this.boundary(job, this.dependencies.evidence.putJson(job.sessionId, result, { kind: "visual_comparison" }));
        evidence.push(report.observationUri);
        result = VisualComparisonResultSchema.parse({ ...result, reportObservationUri: report.observationUri });
        if (!result.passed) throw scenarioError("ASSERTION_FAILED", "Visual comparison did not satisfy its declared tolerances", evidence);
        return { paused, summary: { passed: true, resultSha256: result.resultSha256 }, evidence };
      }
    }
  }

  private async assertRuntime(
    job: ScenarioJob,
    handle: RuntimeHandle,
    assertion: Extract<ScenarioDeclaration["steps"][number], { kind: "assert" }>["assertion"],
  ): Promise<void> {
    if (assertion.type === "log_matches") {
      await this.boundary(job, this.dependencies.runtime.execute({
        operation: "wait",
        handle,
        timeoutMs: 1,
        condition: assertion,
      })).catch((error: unknown) => {
        rethrowIfInterrupted(error);
        throw scenarioError("ASSERTION_FAILED", "Runtime log assertion failed");
      });
      return;
    }
    if (assertion.type === "no_error_logs") {
      const response = await this.boundary(job, this.dependencies.runtime.execute({
        operation: "logs",
        handle,
        afterSequence: 0,
        levels: ["error", "script", "shader"],
        limit: 1,
      }));
      if (!isRecord(response) || !Array.isArray(response.records) || response.records.length > 0) {
        throw scenarioError("ASSERTION_FAILED", "Runtime error-log assertion failed");
      }
      return;
    }
    let response: unknown;
    try {
      response = await this.boundary(job, this.dependencies.runtime.execute({
        operation: "node",
        handle,
        nodePath: assertion.nodePath,
        includeProperties: assertion.type === "property_equals" || assertion.type === "property_matches",
        includeSignals: false,
      }));
    } catch (error) {
      rethrowIfInterrupted(error);
      if (assertion.type === "node_missing" && errorCode(error) === "TARGET_NOT_FOUND") return;
      throw scenarioError("ASSERTION_FAILED", "Runtime node assertion failed");
    }
    if (assertion.type === "node_missing") throw scenarioError("ASSERTION_FAILED", "Runtime node-missing assertion failed");
    if (assertion.type === "node_exists") return;
    if (!isRecord(response) || !Array.isArray(response.properties)) throw scenarioError("ASSERTION_FAILED", "Runtime property assertion failed");
    const property = response.properties.find((entry) => isRecord(entry) && entry.name === assertion.property);
    if (!isRecord(property)) throw scenarioError("ASSERTION_FAILED", "Runtime property assertion failed");
    if (assertion.type === "property_equals") {
      if (!Object.is(property.value, assertion.value)) throw scenarioError("ASSERTION_FAILED", "Runtime property equality assertion failed");
      return;
    }
    if (typeof property.value !== "string" || !wildcardMatches(property.value, assertion.pattern)) {
      throw scenarioError("ASSERTION_FAILED", "Runtime property pattern assertion failed");
    }
  }

  private async boundary<T>(job: ScenarioJob, promise: Promise<T>): Promise<T> {
    this.assertJobActive(job);
    const remaining = job.deadlineAtMs - Math.floor(this.now());
    if (remaining <= 0) throw scenarioError("TIMEOUT", "Visual scenario deadline expired");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const interruption = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(scenarioError("TIMEOUT", "Visual scenario deadline expired")), remaining);
      abortListener = () => reject(job.controller.signal.reason ?? scenarioError("CANCELLED", "Visual scenario was cancelled"));
      job.controller.signal.addEventListener("abort", abortListener, { once: true });
    });
    promise.catch(() => undefined);
    try {
      return await Promise.race([promise, interruption]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abortListener) job.controller.signal.removeEventListener("abort", abortListener);
    }
  }

  private assertJobActive(job: ScenarioJob): void {
    if (job.controller.signal.aborted) {
      throw job.controller.signal.reason ?? scenarioError("CANCELLED", "Visual scenario was cancelled");
    }
  }
}
