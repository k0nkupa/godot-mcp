import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createPhase7RuntimeFixture } from "./runtime-phase7-fixture.js";

test("hits a real Godot DAP breakpoint and reads bounded stack and watch data", async () => {
  const fixture = await createPhase7RuntimeFixture();
  let phase = "launch";
  try {
    const sourcePath = join(fixture.projectRoot, "debug/debug_fixture.gd");
    const source = await readFile(sourcePath, "utf8");
    const breakpointLine = source.split("\n").findIndex((line) => line.includes("PHASE7_BREAKPOINT_INNER")) + 1;
    expect(breakpointLine).toBeGreaterThan(0);
    const launched = await fixture.runtime.launch({ scenePath: "res://debug/debug_fixture.tscn", startupTimeoutMs: 15_000 });

    phase = "set-breakpoint";
    const set = await fixture.runtime.execute({
      operation: "debug_breakpoints_set",
      handle: launched.handle,
      breakpoints: [{ sourcePath: "res://debug/debug_fixture.gd", line: breakpointLine }],
    }) as { breakpoints: Array<{ verified: boolean; resolvedLine: number }> };
    expect(set.breakpoints).toEqual([expect.objectContaining({ verified: true, resolvedLine: breakpointLine })]);

    phase = "wait-breakpoint";
    const stopped = await fixture.runtime.execute({ operation: "debug_wait", handle: launched.handle, afterSequence: 0, timeoutMs: 10_000 });
    expect(stopped).toMatchObject({ reason: "breakpoint" });

    phase = "stack";
    const stack = await fixture.runtime.execute({ operation: "debug_stack", handle: launched.handle, offset: 0, limit: 64 }) as {
      frames: Array<{ frameToken: string; name: string; sourcePath?: string }>;
    };
    expect(stack.frames.map((frame) => frame.name)).toEqual(expect.arrayContaining(["_inner", "_middle", "_outer"]));
    const inner = stack.frames.find((frame) => frame.name === "_inner");
    expect(inner).toMatchObject({ frameToken: expect.stringMatching(/^dft_/), sourcePath: "res://debug/debug_fixture.gd" });
    const opaqueFrame = inner!.frameToken;

    phase = "locals";
    const locals = await fixture.runtime.execute({
      operation: "debug_variables",
      handle: launched.handle,
      frameToken: opaqueFrame,
      scope: "locals",
      offset: 0,
      limit: 100,
    }) as { variables: Array<{ name: string; value: string; variableToken?: string }> };
    expect(locals.variables.map((variable) => variable.name)).toEqual(expect.arrayContaining(["player", "vector", "remote_object"]));
    phase = "watch";
    const watched = await fixture.runtime.execute({
      operation: "debug_watch",
      handle: launched.handle,
      frameToken: opaqueFrame,
      selectors: [{ scope: "locals", path: ["player", "health"] }],
    }) as { watches: Array<{ status: string; variable?: { value: string } }> };
    expect(watched.watches).toEqual([expect.objectContaining({ status: "found", variable: expect.objectContaining({ value: expect.stringContaining("100") }) })]);

    phase = "clear-and-continue";
    await fixture.runtime.execute({ operation: "debug_breakpoints_set", handle: launched.handle, breakpoints: [] });
    await fixture.runtime.execute({ operation: "debug_continue", handle: launched.handle });
    await expect(fixture.runtime.execute({
      operation: "debug_variables",
      handle: launched.handle,
      frameToken: opaqueFrame,
      scope: "locals",
      offset: 0,
      limit: 100,
    })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await fixture.runtime.execute({ operation: "stop", handle: launched.handle });
  } catch (error) {
    throw new Error(`Phase: ${phase}\n${String(error)}\n${fixture.diagnostics()}`);
  } finally {
    await fixture.close();
  }
}, 60_000);
