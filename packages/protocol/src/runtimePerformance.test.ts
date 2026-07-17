import { describe, expect, it } from "vitest";

import {
  MonitorSnapshotSchema,
  ProfileEvidenceSchema,
  ProfileJobReceiptSchema,
  ProfileJobTokenSchema,
  ProfileResultSchema,
  RuntimePerformanceOperationInputSchema,
} from "./runtimePerformance.js";

const handle = { runId: "019f644c-1379-79c0-825e-66a4b7653bd1", generation: 1 };
const opaqueProfile = `pjt_${"c".repeat(43)}`;

function withProfileReference(value: string): { jobToken: string } {
  return { ["jobToken"]: value };
}

describe("Phase 7 runtime performance schemas", () => {
  it("accepts the closed performance operation surface", () => {
    expect(RuntimePerformanceOperationInputSchema.parse({ operation: "monitor_snapshot", handle })).toMatchObject({
      operation: "monitor_snapshot",
      groups: ["frame", "memory", "objects", "rendering", "physics", "audio", "navigation", "pipeline", "custom"],
    });
    expect(RuntimePerformanceOperationInputSchema.parse({
      operation: "profile_start",
      handle,
      durationMs: 1_000,
      intervalFrames: 2,
      groups: ["frame", "memory"],
      retainRaw: true,
    })).toMatchObject({ operation: "profile_start" });
    for (const operation of ["profile_status", "profile_cancel", "profile_result"] as const) {
      expect(RuntimePerformanceOperationInputSchema.parse({ operation, handle, ...withProfileReference(opaqueProfile) }).operation).toBe(operation);
    }
  });

  it("enforces capture and group bounds", () => {
    expect(() => RuntimePerformanceOperationInputSchema.parse({ operation: "profile_start", handle, durationMs: 99, intervalFrames: 1, groups: ["frame"], retainRaw: false })).toThrow();
    expect(() => RuntimePerformanceOperationInputSchema.parse({ operation: "profile_start", handle, durationMs: 30_001, intervalFrames: 1, groups: ["frame"], retainRaw: false })).toThrow();
    expect(() => RuntimePerformanceOperationInputSchema.parse({ operation: "profile_start", handle, durationMs: 1_000, intervalFrames: 121, groups: ["frame"], retainRaw: false })).toThrow();
    expect(() => RuntimePerformanceOperationInputSchema.parse({ operation: "monitor_snapshot", handle, groups: ["frame", "frame"] })).toThrow();
    expect(() => RuntimePerformanceOperationInputSchema.parse({ operation: "profile_status", handle, ...withProfileReference(opaqueProfile), extra: true })).toThrow();
  });

  it("validates snapshots and bounded profile evidence", () => {
    expect(MonitorSnapshotSchema.parse({
      schemaVersion: 1,
      frame: 12,
      monotonicUsec: 99,
      engine: { version: "4.7.stable.official.test", renderer: "gl_compatibility", renderingMethod: "gl_compatibility", graphicsApi: "OpenGL" },
      groups: { frame: { time_fps: 60, time_process: 0.01 } },
      unavailable: [],
      gpuTimestamps: { supported: false },
    })).toMatchObject({ frame: 12 });
    const baseline = ProfileEvidenceSchema.parse({
      schemaVersion: 1,
      ...withProfileReference(opaqueProfile),
      state: "completed",
      complete: true,
      startedMonotonicUsec: 1,
      finishedMonotonicUsec: 2,
      startFrame: 1,
      endFrame: 2,
      requestedDurationMs: 100,
      intervalFrames: 1,
      observedSamples: 1,
      retainedSamples: 1,
      invalidSamples: 0,
      droppedSamples: 0,
      aggregates: { time_fps: { min: 60, max: 60, mean: 60, p50: 60, p95: 60, p99: 60 } },
      rawSamples: [],
      engine: { version: "4.7.stable.official.test", renderer: "gl_compatibility", renderingMethod: "gl_compatibility", graphicsApi: "OpenGL" },
      gpuTimestamps: { supported: false },
      sha256: "a".repeat(64),
    });
    expect(baseline).toMatchObject({ state: "completed", observedSamples: 1 });
    const flattenedCustomMetric = `custom.${"m".repeat(128)}`;
    expect(ProfileEvidenceSchema.parse({
      ...baseline,
      retainedSamples: 1,
      aggregates: { [flattenedCustomMetric]: baseline.aggregates.time_fps },
      rawSamples: [{ frame: 1, monotonicUsec: 1, values: { [flattenedCustomMetric]: 60 } }],
    })).toMatchObject({ retainedSamples: 1 });
  });

  it("validates opaque job tokens", () => {
    expect(ProfileJobTokenSchema.parse(opaqueProfile)).toBe(opaqueProfile);
    expect(() => ProfileJobTokenSchema.parse("pjt_short")).toThrow();
  });

  it("parses strict profile receipts and requires matching terminal state", () => {
    expect(ProfileJobReceiptSchema.parse({
      ...withProfileReference(opaqueProfile),
      state: "completed",
      progress: 1,
      observedSamples: 1,
      retainedSamples: 0,
    })).toMatchObject({ state: "completed" });
    const evidence = {
      schemaVersion: 1 as const,
      ...withProfileReference(opaqueProfile),
      state: "completed" as const,
      complete: true,
      startedMonotonicUsec: 1,
      finishedMonotonicUsec: 2,
      startFrame: 1,
      endFrame: 2,
      requestedDurationMs: 100,
      intervalFrames: 1,
      observedSamples: 0,
      retainedSamples: 0,
      invalidSamples: 0,
      droppedSamples: 0,
      aggregates: {},
      rawSamples: [],
      engine: { version: "4.7", renderer: "headless", renderingMethod: "gl_compatibility", graphicsApi: "unavailable" },
      gpuTimestamps: { supported: false as const },
      sha256: "a".repeat(64),
    };
    expect(ProfileResultSchema.parse({ state: "completed", evidence })).toMatchObject({ state: "completed" });
    expect(() => ProfileResultSchema.parse({ state: "cancelled", evidence })).toThrow();
  });
});
