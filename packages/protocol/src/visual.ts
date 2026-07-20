import { z } from "zod";

import { InputTraceSchema } from "./input.js";
import {
  RuntimeNodePathSchema,
  RuntimePrimitiveSchema,
  RuntimeScenePathSchema,
  RuntimeWaitConditionSchema,
  SafeRuntimePropertyPatternSchema,
} from "./runtime.js";
import { RuntimeHandleSchema, RuntimeLaunchPinsSchema } from "./runtimeShared.js";

const MAX_SCENARIO_BYTES = 512 * 1024;
const VisualNameSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const ScenarioJobTokenSchema = z.string().regex(/^vsj_[A-Za-z0-9_-]{43}$/);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const EvidenceObservationUriSchema = z.string().regex(
  /^godot-mcp:\/\/evidence\/[a-f0-9]{64}\/observations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);

export const VisualRectSchema = z
  .object({
    x: z.number().int().min(0).max(2047),
    y: z.number().int().min(0).max(2047),
    width: z.number().int().min(1).max(2048),
    height: z.number().int().min(1).max(2048),
  })
  .strict();

export const VisualComparisonSettingsSchema = z
  .object({
    region: VisualRectSchema.optional(),
    masks: z.array(VisualRectSchema).max(64).default([]),
    maxChannelDelta: z.number().int().min(0).max(255),
    maxDifferentPixels: z.number().int().min(0).max(4_194_304),
    maxDifferentRatioMillionths: z.number().int().min(0).max(1_000_000),
  })
  .strict();

const RuntimeAssertionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("node_exists"), nodePath: RuntimeNodePathSchema }).strict(),
  z.object({ type: z.literal("node_missing"), nodePath: RuntimeNodePathSchema }).strict(),
  z.object({
    type: z.literal("property_equals"),
    nodePath: RuntimeNodePathSchema,
    property: z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    value: RuntimePrimitiveSchema,
  }).strict(),
  z.object({
    type: z.literal("property_matches"),
    nodePath: RuntimeNodePathSchema,
    property: z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    pattern: SafeRuntimePropertyPatternSchema,
  }).strict(),
  z.object({
    type: z.literal("log_matches"),
    pattern: z.string().min(1).max(256),
    level: z.enum(["log", "warning", "error", "script", "shader"]).optional(),
  }).strict(),
  z.object({ type: z.literal("no_error_logs") }).strict(),
]);

const ScenarioStepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("wait"),
    timeoutMs: z.number().int().min(1).max(30_000).default(10_000),
    condition: RuntimeWaitConditionSchema,
  }).strict(),
  z.object({ kind: z.literal("assert"), assertion: RuntimeAssertionSchema }).strict(),
  z.object({
    kind: z.literal("control"),
    action: z.enum(["pause", "resume", "step"]),
    frames: z.number().int().min(1).max(120).optional(),
  }).strict().superRefine((step, context) => {
    if (step.action === "step" && step.frames === undefined) {
      context.addIssue({ code: "custom", message: "Step control requires frames", path: ["frames"] });
    }
    if (step.action !== "step" && step.frames !== undefined) {
      context.addIssue({ code: "custom", message: "Only step control accepts frames", path: ["frames"] });
    }
  }),
  z.object({
    kind: z.literal("input"),
    mode: z.enum(["realtime", "deterministic"]).default("realtime"),
    timeoutMs: z.number().int().min(1).max(30_000).default(10_000),
    trace: InputTraceSchema,
  }).strict(),
  z.object({
    kind: z.literal("capture"),
    label: VisualNameSchema,
    maxWidth: z.number().int().min(1).max(2048).default(1280),
    maxHeight: z.number().int().min(1).max(2048).default(720),
    frameCount: z.number().int().min(1).max(8).default(1),
    intervalFrames: z.number().int().min(1).max(120).default(1),
    advancePaused: z.boolean().default(false),
  }).strict(),
  z.object({
    kind: z.literal("compare"),
    captureLabel: VisualNameSchema,
    frameIndex: z.number().int().min(0).max(7),
    baselineName: VisualNameSchema,
    settings: VisualComparisonSettingsSchema,
  }).strict(),
]);

export const ScenarioDeclarationSchema = z
  .object({
    name: VisualNameSchema,
    scenePath: RuntimeScenePathSchema,
    startupTimeoutMs: z.number().int().min(1_000).max(30_000).default(15_000),
    deadlineMs: z.number().int().min(1_000).max(120_000).default(60_000),
    pins: RuntimeLaunchPinsSchema,
    steps: z.array(ScenarioStepSchema).min(1).max(64),
  })
  .strict()
  .superRefine((scenario, context) => {
    const captures = new Set<string>();
    for (const [index, step] of scenario.steps.entries()) {
      if (step.kind === "capture") {
        if (captures.has(step.label)) {
          context.addIssue({ code: "custom", message: "Capture labels must be unique", path: ["steps", index, "label"] });
        }
        captures.add(step.label);
      } else if (step.kind === "compare" && !captures.has(step.captureLabel)) {
        context.addIssue({ code: "custom", message: "Comparison must reference an earlier capture", path: ["steps", index, "captureLabel"] });
      }
    }
    if (new TextEncoder().encode(JSON.stringify(scenario)).byteLength > MAX_SCENARIO_BYTES) {
      context.addIssue({ code: "custom", message: "Scenario document exceeds 512 KiB" });
    }
  });

export const VisualComparisonResultSchema = z.object({
  passed: z.boolean(),
  comparedPixels: z.number().int().min(0).max(4_194_304),
  maskedPixels: z.number().int().min(0).max(4_194_304),
  differentPixels: z.number().int().min(0).max(4_194_304),
  differentRatioMillionths: z.number().int().min(0).max(1_000_000),
  maxObservedChannelDelta: z.number().int().min(0).max(255),
  baselineSha256: Sha256Schema,
  currentSha256: Sha256Schema,
  settings: VisualComparisonSettingsSchema,
  resultSha256: Sha256Schema,
  diffObservationUri: EvidenceObservationUriSchema.optional(),
  reportObservationUri: EvidenceObservationUriSchema.optional(),
}).strict();

const ScenarioJobStateSchema = z.enum(["queued", "running", "completed", "failed", "cancelled"]);

export const ScenarioJobReceiptSchema = z.object({
  jobToken: ScenarioJobTokenSchema,
  state: ScenarioJobStateSchema,
  completedSteps: z.number().int().min(0).max(64),
  totalSteps: z.number().int().min(1).max(64),
}).strict();

const ScenarioStepReceiptSchema = z.object({
  index: z.number().int().min(0).max(63),
  kind: z.enum(["wait", "assert", "control", "input", "capture", "compare"]),
  state: z.enum(["completed", "failed", "cancelled"]),
  startedMonotonicMs: z.number().int().min(0),
  finishedMonotonicMs: z.number().int().min(0),
  summary: z.record(z.string(), z.unknown()),
  evidence: z.array(EvidenceObservationUriSchema).max(16),
}).strict();

export const ScenarioReportSchema = z.object({
  schemaVersion: z.literal(1),
  comparisonContractVersion: z.literal(1),
  jobToken: ScenarioJobTokenSchema,
  scenarioName: VisualNameSchema,
  projectId: z.uuid(),
  scenePath: RuntimeScenePathSchema,
  handle: RuntimeHandleSchema.optional(),
  pins: RuntimeLaunchPinsSchema,
  observedGodotVersion: z.string().min(1).max(128).optional(),
  observedPins: RuntimeLaunchPinsSchema.optional(),
  state: z.enum(["completed", "failed", "cancelled"]),
  failedStepIndex: z.number().int().min(0).max(63).nullable(),
  steps: z.array(ScenarioStepReceiptSchema).max(64),
  durationMs: z.number().int().min(0).max(120_000),
  cleanup: z.enum(["succeeded", "failed", "not_needed"]),
  reportSha256: Sha256Schema,
  reportObservationUri: EvidenceObservationUriSchema.optional(),
}).strict();

export const VisualOperationInputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("baseline_create"), name: VisualNameSchema, observationUri: EvidenceObservationUriSchema }).strict(),
  z.object({ operation: z.literal("baseline_get"), name: VisualNameSchema }).strict(),
  z.object({ operation: z.literal("compare"), name: VisualNameSchema, observationUri: EvidenceObservationUriSchema, settings: VisualComparisonSettingsSchema }).strict(),
  z.object({ operation: z.literal("scenario_start"), scenario: ScenarioDeclarationSchema }).strict(),
  z.object({ operation: z.literal("scenario_status"), jobToken: ScenarioJobTokenSchema }).strict(),
  z.object({ operation: z.literal("scenario_cancel"), jobToken: ScenarioJobTokenSchema }).strict(),
  z.object({ operation: z.literal("scenario_result"), jobToken: ScenarioJobTokenSchema }).strict(),
]);

export { RuntimeLaunchPinsSchema } from "./runtimeShared.js";
export type RuntimeLaunchPins = z.infer<typeof RuntimeLaunchPinsSchema>;
export type VisualComparisonSettings = z.infer<typeof VisualComparisonSettingsSchema>;
export type VisualComparisonResult = z.infer<typeof VisualComparisonResultSchema>;
export type ScenarioDeclaration = z.infer<typeof ScenarioDeclarationSchema>;
export type ScenarioJobReceipt = z.infer<typeof ScenarioJobReceiptSchema>;
export type ScenarioReport = z.infer<typeof ScenarioReportSchema>;
export type VisualOperationInput = z.infer<typeof VisualOperationInputSchema>;
