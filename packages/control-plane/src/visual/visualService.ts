import { randomUUID } from "node:crypto";

import {
  VisualComparisonResultSchema,
  VisualOperationInputSchema,
  type VisualOperationInput,
} from "@godot-mcp/protocol";

import { GodotMcpException } from "../errors.js";
import type { EvidenceStore } from "../evidence/evidenceStore.js";
import { comparePng } from "./pngComparison.js";

export interface VisualScenarioController {
  start(input: unknown): unknown;
  status(jobToken: string): unknown;
  cancel(jobToken: string): unknown;
  result(jobToken: string): unknown;
}

export interface VisualServiceDependencies {
  sessionId(): string | null;
  evidence: EvidenceStore;
  scenario: VisualScenarioController;
}

export interface VisualExecutionResult {
  data: unknown;
  evidence?: string[];
  images?: Array<{ data: Uint8Array; mimeType: "image/png" }>;
}

function visualError(code: "NOT_ATTACHED" | "GODOT_RUNTIME_ERROR", message: string): GodotMcpException {
  return new GodotMcpException({
    code,
    message,
    retryable: false,
    correlationId: randomUUID(),
    partialEffects: false,
    rollback: "not_needed",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class VisualService {
  constructor(private readonly dependencies: VisualServiceDependencies) {}

  async execute(rawInput: VisualOperationInput): Promise<VisualExecutionResult> {
    const input = VisualOperationInputSchema.parse(rawInput);
    if (input.operation === "scenario_start") return { data: this.dependencies.scenario.start(input.scenario) };
    if (input.operation === "scenario_status") return { data: this.dependencies.scenario.status(input.jobToken) };
    if (input.operation === "scenario_cancel") return { data: this.dependencies.scenario.cancel(input.jobToken) };
    if (input.operation === "scenario_result") {
      const report = this.dependencies.scenario.result(input.jobToken);
      const reportObservationUri = isRecord(report) && typeof report.reportObservationUri === "string"
        ? report.reportObservationUri
        : undefined;
      return { data: report, ...(reportObservationUri ? { evidence: [reportObservationUri] } : {}) };
    }
    const sessionId = this.dependencies.sessionId();
    if (!sessionId) throw visualError("NOT_ATTACHED", "Godot editor addon is not attached");
    if (input.operation === "baseline_create") {
      return { data: await this.dependencies.evidence.createPngBaseline(sessionId, input.name, input.observationUri) };
    }
    if (input.operation === "baseline_get") {
      return { data: await this.dependencies.evidence.readPngBaseline(input.name) };
    }
    const current = await this.dependencies.evidence.readSessionPngObservation(sessionId, input.observationUri);
    const baseline = await this.dependencies.evidence.readPngBaselineData(input.name);
    const compared = comparePng({ baseline: baseline.data, current: current.data, settings: input.settings });
    const evidence: string[] = [current.observationUri];
    let result = compared.result;
    let images: VisualExecutionResult["images"];
    if (compared.diffPng) {
      const diff = await this.dependencies.evidence.putPng(sessionId, compared.diffPng, {
        source: "runtime",
        viewport: "runtime",
        width: current.width,
        height: current.height,
      });
      evidence.push(diff.observationUri);
      result = VisualComparisonResultSchema.parse({ ...result, diffObservationUri: diff.observationUri });
      images = [{ data: compared.diffPng, mimeType: "image/png" }];
    }
    const report = await this.dependencies.evidence.putJson(sessionId, result, { kind: "visual_comparison" });
    evidence.push(report.observationUri);
    result = VisualComparisonResultSchema.parse({ ...result, reportObservationUri: report.observationUri });
    return { data: result, evidence, ...(images ? { images } : {}) };
  }
}
