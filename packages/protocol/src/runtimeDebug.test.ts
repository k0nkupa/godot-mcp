import { describe, expect, it } from "vitest";

import {
  DebugFrameTokenSchema,
  DebugVariableTokenSchema,
  RuntimeDebugOperationInputSchema,
} from "./runtimeDebug.js";

const handle = { runId: "019f644c-1379-79c0-825e-66a4b7653bd1", generation: 1 };
const frameToken = `dft_${"a".repeat(43)}`;
const variableToken = `dvt_${"b".repeat(43)}`;

describe("Phase 7 runtime debugging schemas", () => {
  it("accepts the closed debugger operation surface", () => {
    expect(RuntimeDebugOperationInputSchema.parse({
      operation: "debug_breakpoints_set",
      handle,
      breakpoints: [{ sourcePath: "res://debug/debug_fixture.gd", line: 17 }],
    })).toMatchObject({ operation: "debug_breakpoints_set" });
    expect(RuntimeDebugOperationInputSchema.parse({ operation: "debug_status", handle })).toMatchObject({ operation: "debug_status" });
    expect(RuntimeDebugOperationInputSchema.parse({ operation: "debug_wait", handle })).toMatchObject({ operation: "debug_wait", afterSequence: 0, timeoutMs: 10_000 });
    for (const operation of ["debug_pause", "debug_continue", "debug_step_over", "debug_step_into"] as const) {
      expect(RuntimeDebugOperationInputSchema.parse({ operation, handle }).operation).toBe(operation);
    }
    expect(RuntimeDebugOperationInputSchema.parse({ operation: "debug_stack", handle })).toMatchObject({ operation: "debug_stack", offset: 0, limit: 64 });
    expect(RuntimeDebugOperationInputSchema.parse({ operation: "debug_variables", handle, frameToken, scope: "locals" })).toMatchObject({ offset: 0, limit: 100 });
    expect(RuntimeDebugOperationInputSchema.parse({ operation: "debug_children", handle, variableToken })).toMatchObject({ offset: 0, limit: 100 });
    expect(RuntimeDebugOperationInputSchema.parse({
      operation: "debug_watch",
      handle,
      frameToken,
      selectors: [{ scope: "locals", path: ["player", "health"] }, { scope: "members", path: ["items", 0] }],
    })).toMatchObject({ operation: "debug_watch" });
  });

  it.each([
    "res://../escape.gd",
    "res://addons/godot_mcp/plugin.gd",
    "res://debug/not_script.txt",
    "/tmp/escape.gd",
  ])("rejects unsafe debugger source %s", (sourcePath) => {
    expect(() => RuntimeDebugOperationInputSchema.parse({
      operation: "debug_breakpoints_set",
      handle,
      breakpoints: [{ sourcePath, line: 1 }],
    })).toThrow();
  });

  it("enforces debugger bounds and strict objects", () => {
    expect(() => RuntimeDebugOperationInputSchema.parse({ operation: "debug_wait", handle, timeoutMs: 30_001 })).toThrow();
    expect(() => RuntimeDebugOperationInputSchema.parse({ operation: "debug_stack", handle, limit: 65 })).toThrow();
    expect(() => RuntimeDebugOperationInputSchema.parse({ operation: "debug_variables", handle, frameToken, scope: "locals", limit: 257 })).toThrow();
    expect(() => RuntimeDebugOperationInputSchema.parse({ operation: "debug_children", handle, variableToken, offset: -1 })).toThrow();
    expect(() => RuntimeDebugOperationInputSchema.parse({
      operation: "debug_watch",
      handle,
      frameToken,
      selectors: [{ scope: "locals", path: Array.from({ length: 9 }, () => "child") }],
    })).toThrow();
    expect(() => RuntimeDebugOperationInputSchema.parse({ operation: "debug_status", handle, evaluate: "quit()" })).toThrow();
  });

  it("validates opaque debugger tokens", () => {
    expect(DebugFrameTokenSchema.parse(frameToken)).toBe(frameToken);
    expect(DebugVariableTokenSchema.parse(variableToken)).toBe(variableToken);
    expect(() => DebugFrameTokenSchema.parse(variableToken)).toThrow();
    expect(() => DebugVariableTokenSchema.parse("dvt_short")).toThrow();
  });
});
