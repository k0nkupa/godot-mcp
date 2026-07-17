import { authorize, DebugTokenStore, DapFrameParser, encodeDapMessage, RUNTIME_POLICY } from "@godot-mcp/control-plane";
import { RuntimeDebugOperationInputSchema, RuntimePerformanceOperationInputSchema } from "@godot-mcp/protocol";
import { describe, expect, it } from "vitest";

const handle = { runId: "019f644c-1379-79c0-825e-66a4b7653bd1", generation: 1 };
const frameToken = `dft_${"a".repeat(43)}`;
const variableToken = `dvt_${"b".repeat(43)}`;
const jobToken = `pjt_${"c".repeat(43)}`;

describe("hostile Phase 7 runtime boundaries", () => {
  it.each([
    { operation: "debug_breakpoints_set", handle, breakpoints: [{ sourcePath: "res://../escape.gd", line: 1 }] },
    { operation: "debug_breakpoints_set", handle, breakpoints: [{ sourcePath: "res://addons/godot_mcp/plugin.gd", line: 1 }] },
    { operation: "debug_breakpoints_set", handle, breakpoints: [{ sourcePath: "res://debug/a.gd", line: 1 }, { sourcePath: "res://debug/a.gd", line: 1 }] },
    { operation: "debug_breakpoints_set", handle, breakpoints: [{ sourcePath: "res://debug/a.gd", line: 1_000_001 }] },
    { operation: "debug_variables", handle, frameToken: "dft_forged", scope: "locals" },
    { operation: "debug_children", handle, variableToken: "dvt_forged" },
    { operation: "debug_watch", handle, frameToken, selectors: [{ scope: "locals", path: Array(9).fill("child") }] },
    { operation: "debug_watch", handle, frameToken, selectors: Array.from({ length: 33 }, () => ({ scope: "locals", path: ["value"] })) },
    { operation: "debug_wait", handle, timeoutMs: 30_001 },
  ])("rejects hostile debugger input %# before dispatch", (input) => {
    expect(() => RuntimeDebugOperationInputSchema.parse(input)).toThrow();
  });

  it.each([
    { operation: "monitor_snapshot", handle, groups: ["frame", "frame"] },
    { operation: "profile_start", handle, durationMs: 99, intervalFrames: 1, groups: ["frame"] },
    { operation: "profile_start", handle, durationMs: 30_001, intervalFrames: 1, groups: ["frame"] },
    { operation: "profile_start", handle, durationMs: 100, intervalFrames: 121, groups: ["frame"] },
    { operation: "profile_start", handle, durationMs: 100, intervalFrames: 1, groups: Array(9).fill("frame") },
    { operation: "profile_status", handle, jobToken: "pjt_forged" },
  ])("rejects hostile profiler input %# before dispatch", (input) => {
    expect(() => RuntimePerformanceOperationInputSchema.parse(input)).toThrow();
  });

  it("requires both runtime_control and the runtime pack", () => {
    expect(() => authorize({ tiers: ["observe"], packs: ["core", "runtime"] }, RUNTIME_POLICY)).toThrow();
    expect(() => authorize({ tiers: ["observe", "runtime_control"], packs: ["core"] }, RUNTIME_POLICY)).toThrow();
    expect(() => authorize({ tiers: ["observe", "runtime_control"], packs: ["core", "runtime"] }, RUNTIME_POLICY)).not.toThrow();
  });

  it("invalidates opaque tokens across every runtime, DAP, and stop identity", () => {
    const store = new DebugTokenStore();
    const identity = { runId: handle.runId, generation: 1, dapGeneration: 1, stopSequence: 1 };
    store.bind(identity);
    const issuedFrame = store.issueFrame(7);
    const issuedVariable = store.issueVariable(9, 1);
    expect(issuedFrame).toMatch(/^dft_[A-Za-z0-9_-]{43}$/);
    expect(issuedVariable).toMatch(/^dvt_[A-Za-z0-9_-]{43}$/);
    for (const changed of [
      { ...identity, runId: "019f644c-1379-79c0-825e-66a4b7653bd2" },
      { ...identity, generation: 2 },
      { ...identity, dapGeneration: 2 },
      { ...identity, stopSequence: 2 },
    ]) {
      store.bind(identity);
      const stale = store.issueFrame(1);
      store.bind(changed);
      expect(() => store.resolveFrame(stale)).toThrow(/stale|unknown/i);
      store.clear();
    }
    expect(frameToken).toMatch(/^dft_/);
    expect(variableToken).toMatch(/^dvt_/);
    expect(jobToken).toMatch(/^pjt_/);
  });

  it.each([
    "Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}",
    "Content-Length: 2\n\n{}",
    `Content-Length: ${1024 * 1024 + 1}\r\n\r\n`,
    "Content-Length: 1\r\n\r\n{",
  ])("fails closed on hostile DAP framing", (frame) => {
    expect(() => new DapFrameParser().push(Buffer.from(frame))).toThrow();
  });

  it("bounds outbound DAP frames to one MiB", () => {
    expect(() => encodeDapMessage({ payload: "x".repeat(1024 * 1024) })).toThrow(/one MiB/i);
  });
});
