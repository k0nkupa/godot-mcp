import { afterEach, describe, expect, it } from "vitest";

import { RuntimeService } from "./runtimeService.js";

const opaqueProfileId = `pjt_${"c".repeat(43)}`;
const cleanups: Array<() => Promise<void>> = [];

function withProfileReference(value: string): { jobToken: string } {
  return { ["jobToken"]: value };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const monitorSnapshot = {
  schemaVersion: 1 as const,
  frame: 12,
  monotonicUsec: 99,
  engine: { version: "4.7", renderer: "headless", renderingMethod: "gl_compatibility", graphicsApi: "unavailable" },
  groups: { frame: { fps: 60 } },
  unavailable: [],
  gpuTimestamps: { supported: false as const },
};

function evidence(state: "completed" | "cancelled" | "failed" = "completed") {
  return {
    schemaVersion: 1 as const,
    ...withProfileReference(opaqueProfileId),
    state,
    complete: state === "completed",
    startedMonotonicUsec: 1,
    finishedMonotonicUsec: 2,
    startFrame: 1,
    endFrame: 2,
    requestedDurationMs: 100,
    intervalFrames: 1,
    observedSamples: 1,
    retainedSamples: 0,
    invalidSamples: 0,
    droppedSamples: 0,
    metricTruncation: { truncated: false, affectedSamples: 0, maxDroppedMetricsPerSample: 0, droppedGroups: [] },
    aggregates: {},
    rawSamples: [],
    engine: monitorSnapshot.engine,
    gpuTimestamps: monitorSnapshot.gpuTimestamps,
    sha256: "a".repeat(64),
  };
}

async function launchedService(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const service = new RuntimeService({
    project: { projectId: "019f644c-1379-79c0-825e-66a4b7653bd1", rootRealPath: "/private/project", projectConfigSha256: "a".repeat(64) },
    sessionId: () => "session_12345678",
    createDescriptor: async (input) => ({
      path: "/private/runtime.json",
      descriptor: { ...input, secret: "a".repeat(43), launchNonce: "b".repeat(43), createdAtUnixMs: 1, expiresAtUnixMs: 60_001, ownerLeasePath: "/private/runtime.lease" },
      secret: Buffer.alloc(32),
      cleanup: async () => undefined,
    }),
    prepare: async () => ({ debugPort: 6007 }),
    launchProcess: async () => ({ pid: 42, fingerprint: "42:start", stop: async () => undefined, wait: async () => new Promise<number>(() => undefined) }),
    command: async (operation) => {
      calls.push(operation);
      if (operation === "await_ready") return { pid: 42 };
      if (operation in overrides) return overrides[operation];
      if (operation === "monitor_snapshot") return monitorSnapshot;
      if (operation === "profile_start" || operation === "profile_status" || operation === "profile_cancel") {
        return { ...withProfileReference(opaqueProfileId), state: operation === "profile_cancel" ? "cancelled" : "running", progress: 0.5, observedSamples: 1, retainedSamples: 0 };
      }
      if (operation === "profile_result") return { state: "completed", evidence: evidence() };
      return {};
    },
  });
  const launched = await service.launch({ scenePath: "res://main.tscn", startupTimeoutMs: 5_000 });
  cleanups.push(() => service.close());
  return { calls, handle: launched.handle, service };
}

describe("Phase 7 RuntimeService performance routing", () => {
  it("strictly parses monitor snapshots and profile receipts", async () => {
    const { handle, service } = await launchedService();
    await expect(service.execute({ operation: "monitor_snapshot", handle, groups: ["frame"] })).resolves.toEqual(monitorSnapshot);
    const started = await service.execute({ operation: "profile_start", handle, durationMs: 100, intervalFrames: 1, groups: ["frame"], retainRaw: false });
    expect(started).toMatchObject({ ...withProfileReference(opaqueProfileId), state: "running" });
    await expect(service.execute({ operation: "profile_result", handle, ...withProfileReference(opaqueProfileId) })).resolves.toMatchObject({ state: "completed", evidence: { sha256: "a".repeat(64) } });
  });

  it("rejects stale profile job tokens without forwarding them", async () => {
    const { calls, handle, service } = await launchedService();
    await service.execute({ operation: "profile_start", handle, durationMs: 100, intervalFrames: 1, groups: ["frame"], retainRaw: false });
    const unknownProfileId = `pjt_${"z".repeat(43)}`;
    await expect(service.execute({ operation: "profile_status", handle, ...withProfileReference(unknownProfileId) })).rejects.toMatchObject({ code: "STALE_HANDLE" });
    expect(calls.filter((operation) => operation === "profile_status")).toHaveLength(0);
  });

  it("fails closed on malformed performance data", async () => {
    const { handle, service } = await launchedService({ monitor_snapshot: { ...monitorSnapshot, groups: { frame: { fps: Number.NaN } } } });
    await expect(service.execute({ operation: "monitor_snapshot", handle, groups: ["frame"] })).rejects.toThrow();
  });
});
