import { z } from "zod";

import { RuntimeHandleSchema } from "./runtimeShared.js";

export const ProfileJobTokenSchema = z.string().regex(/^pjt_[A-Za-z0-9_-]{43}$/);

export const MonitorGroupSchema = z.enum([
  "frame",
  "memory",
  "objects",
  "rendering",
  "physics",
  "audio",
  "navigation",
  "pipeline",
  "custom",
]);

const ALL_MONITOR_GROUPS = MonitorGroupSchema.options;
const MonitorGroupsSchema = z
  .array(MonitorGroupSchema)
  .min(1)
  .max(9)
  .refine((groups) => new Set(groups).size === groups.length, { message: "Monitor groups must be unique" });
const ProfileGroupsSchema = z
  .array(MonitorGroupSchema)
  .min(1)
  .max(8)
  .refine((groups) => new Set(groups).size === groups.length, { message: "Monitor groups must be unique" });

const ProfileJobOperationSchema = <T extends "profile_status" | "profile_cancel" | "profile_result">(operation: T) =>
  z.object({ operation: z.literal(operation), handle: RuntimeHandleSchema, jobToken: ProfileJobTokenSchema }).strict();

export const RuntimePerformanceOperationInputSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("monitor_snapshot"),
      handle: RuntimeHandleSchema,
      groups: MonitorGroupsSchema.default(ALL_MONITOR_GROUPS),
    })
    .strict(),
  z
    .object({
      operation: z.literal("profile_start"),
      handle: RuntimeHandleSchema,
      durationMs: z.number().int().min(100).max(30_000),
      intervalFrames: z.number().int().min(1).max(120),
      groups: ProfileGroupsSchema,
      retainRaw: z.boolean().default(false),
    })
    .strict(),
  ProfileJobOperationSchema("profile_status"),
  ProfileJobOperationSchema("profile_cancel"),
  ProfileJobOperationSchema("profile_result"),
]);

const EngineMetadataSchema = z
  .object({
    version: z.string().min(1).max(128),
    renderer: z.string().min(1).max(128),
    renderingMethod: z.string().min(1).max(128),
    graphicsApi: z.string().min(1).max(128),
  })
  .strict();

const GpuTimestampsSchema = z.discriminatedUnion("supported", [
  z.object({ supported: z.literal(false), reason: z.string().min(1).max(256).optional() }).strict(),
  z.object({ supported: z.literal(true), deltasUsec: z.array(z.number().finite().min(0)).max(2_048) }).strict(),
]);

const MonitorValuesSchema = z
  .record(z.string().min(1).max(128), z.number().finite())
  .refine((values) => Object.keys(values).length <= 128, { message: "A monitor group may contain at most 128 values" });

export const MonitorSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    frame: z.number().int().min(0),
    monotonicUsec: z.number().int().min(0),
    engine: EngineMetadataSchema,
    groups: z.partialRecord(MonitorGroupSchema, MonitorValuesSchema),
    unavailable: z.array(z.string().min(1).max(256)).max(128),
    gpuTimestamps: GpuTimestampsSchema,
  })
  .strict();

const ProfileAggregateSchema = z
  .object({
    min: z.number().finite(),
    max: z.number().finite(),
    mean: z.number().finite(),
    p50: z.number().finite(),
    p95: z.number().finite(),
    p99: z.number().finite(),
  })
  .strict();

const ProfileSampleSchema = z
  .object({
    frame: z.number().int().min(0),
    monotonicUsec: z.number().int().min(0),
    values: z.record(z.string().min(1).max(128), z.number().finite()),
  })
  .strict();

export const ProfileEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobToken: ProfileJobTokenSchema,
    state: z.enum(["completed", "cancelled", "failed"]),
    complete: z.boolean(),
    startedMonotonicUsec: z.number().int().min(0),
    finishedMonotonicUsec: z.number().int().min(0),
    startFrame: z.number().int().min(0),
    endFrame: z.number().int().min(0),
    requestedDurationMs: z.number().int().min(100).max(30_000),
    intervalFrames: z.number().int().min(1).max(120),
    observedSamples: z.number().int().min(0),
    retainedSamples: z.number().int().min(0).max(2_048),
    invalidSamples: z.number().int().min(0),
    droppedSamples: z.number().int().min(0),
    aggregates: z.record(z.string().min(1).max(128), ProfileAggregateSchema),
    rawSamples: z.array(ProfileSampleSchema).max(2_048),
    engine: EngineMetadataSchema,
    gpuTimestamps: GpuTimestampsSchema,
    terminalReason: z.string().min(1).max(256).optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .refine((evidence) => evidence.finishedMonotonicUsec >= evidence.startedMonotonicUsec && evidence.endFrame >= evidence.startFrame, {
    message: "Profile evidence must have monotonic time and frame bounds",
  })
  .refine((evidence) => evidence.retainedSamples === evidence.rawSamples.length || evidence.rawSamples.length === 0, {
    message: "Retained sample metadata must match included raw samples",
  });

export const ProfileJobReceiptSchema = z
  .object({
    jobToken: ProfileJobTokenSchema,
    state: z.enum(["running", "completed", "cancelled", "failed"]),
    progress: z.number().finite().min(0).max(1),
    observedSamples: z.number().int().min(0),
    retainedSamples: z.number().int().min(0).max(2_048),
    terminalReason: z.string().min(1).max(256).optional(),
  })
  .strict();

export const ProfileResultSchema = z
  .object({
    state: z.enum(["completed", "cancelled", "failed"]),
    evidence: ProfileEvidenceSchema,
  })
  .strict()
  .refine((result) => result.state === result.evidence.state, { message: "Profile result state must match its evidence" });

export const RUNTIME_PERFORMANCE_OPERATIONS = [
  "monitor_snapshot",
  "profile_start",
  "profile_status",
  "profile_cancel",
  "profile_result",
] as const;

export type MonitorGroup = z.infer<typeof MonitorGroupSchema>;
export type MonitorSnapshot = z.infer<typeof MonitorSnapshotSchema>;
export type ProfileEvidence = z.infer<typeof ProfileEvidenceSchema>;
export type ProfileJobReceipt = z.infer<typeof ProfileJobReceiptSchema>;
export type ProfileResult = z.infer<typeof ProfileResultSchema>;
export type ProfileJobToken = z.infer<typeof ProfileJobTokenSchema>;
export type RuntimePerformanceOperationInput = z.infer<typeof RuntimePerformanceOperationInputSchema>;
