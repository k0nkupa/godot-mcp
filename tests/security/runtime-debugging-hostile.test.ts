import { AUTHENTICATED_DEBUGGER_COMMANDS, authorize, DebugTokenStore, RUNTIME_POLICY } from "@godot-mcp/control-plane";
import { RuntimeDebugOperationInputSchema, RuntimePerformanceOperationInputSchema } from "@godot-mcp/protocol";
import { describe, expect, it } from "vitest";

const handle = { runId: "019f644c-1379-79c0-825e-66a4b7653bd1", generation: 1 };
const opaqueFrame = `dft_${"a".repeat(43)}`;
const opaqueVariable = `dvt_${"b".repeat(43)}`;
const opaqueProfile = `pjt_${"c".repeat(43)}`;

function withReference(kind: "frameToken" | "variableToken" | "jobToken", value: string): Record<string, string> {
  return { [kind]: value };
}

describe("hostile Phase 7 runtime boundaries", () => {
  it.each([
    { operation: "debug_breakpoints_set", handle, breakpoints: [{ sourcePath: "res://../escape.gd", line: 1 }] },
    { operation: "debug_breakpoints_set", handle, breakpoints: [{ sourcePath: "res://addons/godot_mcp/plugin.gd", line: 1 }] },
    { operation: "debug_breakpoints_set", handle, breakpoints: [{ sourcePath: "res://debug/a.gd", line: 1 }, { sourcePath: "res://debug/a.gd", line: 1 }] },
    { operation: "debug_breakpoints_set", handle, breakpoints: [{ sourcePath: "res://debug/a.gd", line: 1_000_001 }] },
    { operation: "debug_variables", handle, ...withReference("frameToken", "dft_forged"), scope: "locals" },
    { operation: "debug_children", handle, ...withReference("variableToken", "dvt_forged") },
    { operation: "debug_watch", handle, ...withReference("frameToken", opaqueFrame), selectors: [{ scope: "locals", path: Array(9).fill("child") }] },
    { operation: "debug_watch", handle, ...withReference("frameToken", opaqueFrame), selectors: Array.from({ length: 33 }, () => ({ scope: "locals", path: ["value"] })) },
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
    { operation: "profile_status", handle, ...withReference("jobToken", "pjt_forged") },
  ])("rejects hostile profiler input %# before dispatch", (input) => {
    expect(() => RuntimePerformanceOperationInputSchema.parse(input)).toThrow();
  });

  it("requires both runtime_control and the runtime pack", () => {
    expect(() => authorize({ tiers: ["observe"], packs: ["core", "runtime"] }, RUNTIME_POLICY)).toThrow();
    expect(() => authorize({ tiers: ["observe", "runtime_control"], packs: ["core"] }, RUNTIME_POLICY)).toThrow();
    expect(() => authorize({ tiers: ["observe", "runtime_control"], packs: ["core", "runtime"] }, RUNTIME_POLICY)).not.toThrow();
  });

  it("invalidates opaque tokens across every runtime, debugger, and stop identity", () => {
    const store = new DebugTokenStore();
    const identity = { runId: handle.runId, generation: 1, debuggerGeneration: 1, stopSequence: 1 };
    store.bind(identity);
    const issuedFrame = store.issueFrame(7);
    const issuedVariable = store.issueVariable(9, 1);
    expect(issuedFrame).toMatch(/^dft_[A-Za-z0-9_-]{43}$/);
    expect(issuedVariable).toMatch(/^dvt_[A-Za-z0-9_-]{43}$/);
    for (const changed of [
      { ...identity, runId: "019f644c-1379-79c0-825e-66a4b7653bd2" },
      { ...identity, generation: 2 },
      { ...identity, debuggerGeneration: 2 },
      { ...identity, stopSequence: 2 },
    ]) {
      store.bind(identity);
      const stale = store.issueFrame(1);
      store.bind(changed);
      expect(() => store.resolveFrame(stale)).toThrow(/stale|unknown/i);
      store.clear();
    }
    expect(opaqueFrame).toMatch(/^dft_/);
    expect(opaqueVariable).toMatch(/^dvt_/);
    expect(opaqueProfile).toMatch(/^pjt_/);
  });

  it("keeps the authenticated debugger command surface closed-world", () => {
    expect(AUTHENTICATED_DEBUGGER_COMMANDS).toEqual([
      "disconnect", "setBreakpoints", "threads", "stackTrace", "scopes",
      "variables", "pause", "continue", "next", "stepIn",
    ]);
    expect(AUTHENTICATED_DEBUGGER_COMMANDS).not.toContain("evaluate");
    expect(AUTHENTICATED_DEBUGGER_COMMANDS).not.toContain("setVariable");
  });
});
