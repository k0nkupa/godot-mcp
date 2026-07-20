import { createHash } from "node:crypto";

import { canonicalJson } from "@godot-mcp/protocol";
import { createRgbaPng, copyFixture } from "@godot-mcp/testkit";
import { describe, expect, it } from "vitest";

import { EvidenceStore } from "../evidence/evidenceStore.js";
import { ScenarioService, type ScenarioRuntime } from "./scenarioService.js";

const projectId = "019f644c-1379-79c0-825e-66a4b7653bd1";
const handle = { runId: "019f644c-1379-79c0-825e-66a4b7653bd2", generation: 1 };
const frame = createRgbaPng(4, 4, () => [0, 0, 0, 255]);

function declaration(steps: unknown[]) {
  return {
    name: "scenario-test",
    scenePath: "res://visual/visual_fixture.tscn",
    startupTimeoutMs: 1_000,
    deadlineMs: 5_000,
    pins: { width: 320, height: 180, renderer: "gl_compatibility", locale: "en_NZ", seed: 42, fixedFps: 60 },
    steps,
  };
}

function runtime(overrides: Partial<ScenarioRuntime> = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const implementation: ScenarioRuntime = {
    async launch(input) {
      calls.push({ method: "launch", ...input });
      return {
        handle,
        root: {
          godotVersion: "4.7.stable.official.5b4e0cb0f",
          observedPins: { width: 320, height: 180, renderer: "gl_compatibility", locale: "en_NZ", seed: 42, fixedFps: 60 },
        },
      };
    },
    async execute(input) {
      calls.push({ method: "execute", ...input });
      if (input.operation === "node") return { properties: [{ name: "mode", value: "ready" }] };
      if (input.operation === "logs") return { records: [] };
      return { satisfied: true };
    },
    async input(input) {
      calls.push({ method: "input", ...input });
      return { receipt: { deliveredCount: 1 } };
    },
    async capture(input) {
      calls.push({ method: "capture", ...input });
      return {
        frames: [{
          data: frame,
          metadata: {
            mimeType: "image/png" as const,
            width: 4,
            height: 4,
            byteLength: frame.byteLength,
            sha256: createHash("sha256").update(frame).digest("hex"),
            frameIndex: 0,
          },
        }],
      };
    },
    ...overrides,
  };
  return { implementation, calls };
}

async function terminal(service: ScenarioService, token: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = service.status(token);
    if (["completed", "failed", "cancelled"].includes(status.state)) return status;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Scenario did not reach a terminal state");
}

describe("ScenarioService", () => {
  it("runs steps serially, binds capture evidence, compares a baseline, and cleans up", async () => {
    const project = await copyFixture();
    try {
      const evidence = new EvidenceStore(project.root);
      const source = await evidence.putPng("session_12345678", frame, { viewport: "runtime", width: 4, height: 4 });
      await evidence.createPngBaseline("session_12345678", "ready", source.observationUri, 1);
      const fake = runtime();
      const service = new ScenarioService({ projectId, sessionId: () => "session_12345678", runtime: fake.implementation, evidence });
      const started = service.start(declaration([
        { kind: "wait", timeoutMs: 100, condition: { type: "node_exists", nodePath: "." } },
        { kind: "assert", assertion: { type: "property_equals", nodePath: ".", property: "mode", value: "ready" } },
        { kind: "control", action: "pause" },
        { kind: "input", mode: "deterministic", timeoutMs: 100, trace: { schemaVersion: 1, events: [{ frameOffset: 0, event: { type: "action", action: "ui_accept", pressed: true } }] } },
        { kind: "capture", label: "ready-frame", maxWidth: 4, maxHeight: 4, frameCount: 1, intervalFrames: 1, advancePaused: true },
        { kind: "compare", captureLabel: "ready-frame", frameIndex: 0, baselineName: "ready", settings: { masks: [], maxChannelDelta: 0, maxDifferentPixels: 0, maxDifferentRatioMillionths: 0 } },
        { kind: "assert", assertion: { type: "no_error_logs" } },
      ]));

      await terminal(service, started.jobToken);
      const report = service.result(started.jobToken);
      expect(report).toMatchObject({
        state: "completed",
        failedStepIndex: null,
        cleanup: "succeeded",
        observedPins: { width: 320, height: 180, renderer: "gl_compatibility", locale: "en_NZ", seed: 42, fixedFps: 60 },
      });
      expect(report.steps).toHaveLength(7);
      expect(report.steps[4]?.evidence[0]).toMatch(/^godot-mcp:\/\/evidence\//);
      expect(report.steps[5]).toMatchObject({ summary: { passed: true } });
      expect(report.reportObservationUri).toMatch(/^godot-mcp:\/\/evidence\//);
      expect(fake.calls.map((call) => `${call.method}:${String(call.operation ?? "")}`)).toEqual([
        "launch:", "execute:wait", "execute:node", "execute:pause", "input:replay", "capture:", "execute:logs", "execute:stop",
      ]);
    } finally {
      await project.cleanup();
    }
  });

  it("fails at the exact assertion without leaking compared values and still cleans up", async () => {
    const project = await copyFixture();
    try {
      const fake = runtime();
      const service = new ScenarioService({ projectId, sessionId: () => "session_12345678", runtime: fake.implementation, evidence: new EvidenceStore(project.root) });
      const started = service.start(declaration([
        { kind: "assert", assertion: { type: "property_equals", nodePath: ".", property: "mode", value: "secret-expected" } },
        { kind: "control", action: "pause" },
      ]));

      await terminal(service, started.jobToken);
      const report = service.result(started.jobToken);
      expect(report).toMatchObject({ state: "failed", failedStepIndex: 0, cleanup: "succeeded" });
      expect(JSON.stringify(report)).not.toContain("secret-expected");
      expect(fake.calls.at(-1)).toMatchObject({ method: "execute", operation: "stop", handle });
    } finally {
      await project.cleanup();
    }
  });

  it("retains current, diff, and comparison-report evidence when a comparison fails", async () => {
    const project = await copyFixture();
    try {
      const evidence = new EvidenceStore(project.root);
      const source = await evidence.putPng("session_12345678", frame, { viewport: "runtime", width: 4, height: 4 });
      await evidence.createPngBaseline("session_12345678", "ready", source.observationUri, 1);
      const changed = createRgbaPng(4, 4, () => [255, 0, 0, 255]);
      const fake = runtime({
        async capture() {
          return { frames: [{
            data: changed,
            metadata: {
              mimeType: "image/png" as const,
              width: 4,
              height: 4,
              byteLength: changed.byteLength,
              sha256: createHash("sha256").update(changed).digest("hex"),
              frameIndex: 0,
            },
          }] };
        },
      });
      const service = new ScenarioService({ projectId, sessionId: () => "session_12345678", runtime: fake.implementation, evidence });
      const started = service.start(declaration([
        { kind: "capture", label: "changed", maxWidth: 4, maxHeight: 4, frameCount: 1, intervalFrames: 1, advancePaused: false },
        { kind: "compare", captureLabel: "changed", frameIndex: 0, baselineName: "ready", settings: { masks: [], maxChannelDelta: 0, maxDifferentPixels: 0, maxDifferentRatioMillionths: 0 } },
      ]));

      await terminal(service, started.jobToken);
      const report = service.result(started.jobToken);
      expect(report).toMatchObject({ state: "failed", failedStepIndex: 1 });
      expect(report.steps[1]?.evidence).toHaveLength(3);
      expect(report.steps[1]?.evidence.every((uri) => uri.startsWith("godot-mcp://evidence/"))).toBe(true);
    } finally {
      await project.cleanup();
    }
  });

  it("rejects concurrent jobs, stale tokens, and cross-session access", async () => {
    const project = await copyFixture();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    try {
      const fake = runtime({ execute: async (input) => {
        if (input.operation === "wait") await waiting;
        return { satisfied: true };
      } });
      let sessionId = "session_12345678";
      const service = new ScenarioService({ projectId, sessionId: () => sessionId, runtime: fake.implementation, evidence: new EvidenceStore(project.root) });
      const started = service.start(declaration([{ kind: "wait", timeoutMs: 1_000, condition: { type: "frames_elapsed", frames: 1 } }]));

      expect(() => service.start(declaration([{ kind: "control", action: "pause" }]))).toThrow(/active/i);
      expect(() => service.status(`vsj_${"A".repeat(43)}`)).toThrowError(expect.objectContaining({ code: "STALE_HANDLE" }));
      sessionId = "session_other123";
      expect(() => service.status(started.jobToken)).toThrowError(expect.objectContaining({ code: "STALE_HANDLE" }));
      sessionId = "session_12345678";
      release();
      await terminal(service, started.jobToken);
    } finally {
      release();
      await project.cleanup();
    }
  });

  it("cancels cooperatively and stops only the runtime it launched", async () => {
    const project = await copyFixture();
    try {
      const fake = runtime({ execute: async (input) => {
        fake.calls.push({ method: "execute", ...input });
        if (input.operation === "wait") await new Promise<void>(() => undefined);
        return { satisfied: true };
      } });
      const service = new ScenarioService({ projectId, sessionId: () => "session_12345678", runtime: fake.implementation, evidence: new EvidenceStore(project.root) });
      const started = service.start(declaration([{ kind: "wait", timeoutMs: 1_000, condition: { type: "frames_elapsed", frames: 1 } }]));
      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      service.cancel(started.jobToken);
      await terminal(service, started.jobToken);
      expect(service.result(started.jobToken)).toMatchObject({ state: "cancelled", cleanup: "succeeded" });
      expect(fake.calls.filter((call) => call.operation === "stop")).toEqual([{ method: "execute", operation: "stop", handle }]);
      expect(service.cancel(started.jobToken)).toMatchObject({ state: "cancelled" });
    } finally {
      await project.cleanup();
    }
  });

  it("stops a runtime whose pending launch resolves after cancellation", async () => {
    const project = await copyFixture();
    let resolveLaunch!: (value: Awaited<ReturnType<ScenarioRuntime["launch"]>>) => void;
    const pendingLaunch = new Promise<Awaited<ReturnType<ScenarioRuntime["launch"]>>>((resolve) => {
      resolveLaunch = resolve;
    });
    try {
      const fake = runtime({
        async launch(input) {
          fake.calls.push({ method: "launch", ...input });
          return pendingLaunch;
        },
      });
      const service = new ScenarioService({ projectId, sessionId: () => "session_12345678", runtime: fake.implementation, evidence: new EvidenceStore(project.root) });
      const started = service.start(declaration([{ kind: "control", action: "pause" }]));
      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      service.cancel(started.jobToken);
      resolveLaunch({
        handle,
        root: {
          godotVersion: "4.7.stable.official.5b4e0cb0f",
          observedPins: { width: 320, height: 180, renderer: "gl_compatibility", locale: "en_NZ", seed: 42, fixedFps: 60 },
        },
      });

      await terminal(service, started.jobToken);
      expect(service.result(started.jobToken)).toMatchObject({ state: "cancelled", cleanup: "succeeded", handle });
      expect(fake.calls.filter((call) => call.operation === "stop")).toEqual([{ method: "execute", operation: "stop", handle }]);
    } finally {
      resolveLaunch({ handle, root: {} });
      await project.cleanup();
    }
  });

  it("does not launch when a queued job is cancelled before execution begins", async () => {
    const project = await copyFixture();
    try {
      const fake = runtime();
      const service = new ScenarioService({ projectId, sessionId: () => "session_12345678", runtime: fake.implementation, evidence: new EvidenceStore(project.root) });
      const started = service.start(declaration([{ kind: "control", action: "pause" }]));
      service.cancel(started.jobToken);

      await terminal(service, started.jobToken);
      expect(service.result(started.jobToken)).toMatchObject({ state: "cancelled", cleanup: "not_needed" });
      expect(fake.calls).toEqual([]);
    } finally {
      await project.cleanup();
    }
  });

  it("preserves cancellation while a runtime assertion is pending", async () => {
    const project = await copyFixture();
    try {
      const fake = runtime({ execute: async (input) => {
        fake.calls.push({ method: "execute", ...input });
        if (input.operation === "node") await new Promise<void>(() => undefined);
        return { satisfied: true };
      } });
      const service = new ScenarioService({ projectId, sessionId: () => "session_12345678", runtime: fake.implementation, evidence: new EvidenceStore(project.root) });
      const started = service.start(declaration([{ kind: "assert", assertion: { type: "node_exists", nodePath: "." } }]));
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      service.cancel(started.jobToken);

      await terminal(service, started.jobToken);
      expect(service.result(started.jobToken)).toMatchObject({ state: "cancelled", failedStepIndex: 0 });
    } finally {
      await project.cleanup();
    }
  });

  it("reports cleanup failure and does not turn it into a passing job", async () => {
    const project = await copyFixture();
    try {
      const fake = runtime({ execute: async (input) => {
        if (input.operation === "stop") throw new Error("cleanup failed");
        return { satisfied: true };
      } });
      const service = new ScenarioService({ projectId, sessionId: () => "session_12345678", runtime: fake.implementation, evidence: new EvidenceStore(project.root) });
      const started = service.start(declaration([{ kind: "control", action: "pause" }]));

      await terminal(service, started.jobToken);
      expect(service.result(started.jobToken)).toMatchObject({ state: "failed", cleanup: "failed" });
    } finally {
      await project.cleanup();
    }
  });

  it("recomputes the report digest when report persistence changes the terminal state", async () => {
    const project = await copyFixture();
    try {
      const fake = runtime();
      const evidence = new EvidenceStore(project.root);
      evidence.putJson = async () => { throw new Error("disk unavailable"); };
      const service = new ScenarioService({ projectId, sessionId: () => "session_12345678", runtime: fake.implementation, evidence });
      const started = service.start(declaration([{ kind: "control", action: "pause" }]));

      await terminal(service, started.jobToken);
      const report = service.result(started.jobToken);
      const reportSha256 = report.reportSha256;
      const digestable = Object.fromEntries(Object.entries(report).filter(([key]) =>
        key !== "reportSha256" && key !== "reportObservationUri"));
      expect(report).toMatchObject({ state: "failed" });
      expect(reportSha256).toBe(createHash("sha256").update(canonicalJson(digestable)).digest("hex"));
    } finally {
      await project.cleanup();
    }
  });
});
