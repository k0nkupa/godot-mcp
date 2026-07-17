import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createPhase7RuntimeFixture } from "./runtime-phase7-fixture.js";

test("uses only the authenticated Godot debugger channel for breakpoints and bounded evidence", async () => {
  const fixture = await createPhase7RuntimeFixture();
  let phase = "launch";
  try {
    await expectNativeDapToBeInert(fixture.dapPort);
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
    expect(set.breakpoints).toEqual([expect.objectContaining({
      verified: false,
      resolvedLine: breakpointLine,
      message: expect.stringContaining("cannot confirm an executable source line"),
    })]);

    phase = "wait-breakpoint";
    const stopped = await fixture.runtime.execute({ operation: "debug_wait", handle: launched.handle, afterSequence: 0, timeoutMs: 10_000 });
    expect(stopped).toMatchObject({ reason: "unknown" });

    phase = "stack";
    const stack = await fixture.runtime.execute({ operation: "debug_stack", handle: launched.handle, offset: 0, limit: 64 }) as {
      frames: Array<{ frameToken: string; name: string; sourcePath?: string }>;
    };
    expect(stack.frames.map((frame) => frame.name)).toEqual(expect.arrayContaining(["_inner", "_middle", "_outer"]));
    const inner = stack.frames.find((frame) => frame.name === "_inner");
    expect(inner, `stack=${JSON.stringify(stack)}`).toMatchObject({ frameToken: expect.stringMatching(/^dft_/), sourcePath: "res://debug/debug_fixture.gd" });
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

    phase = "clear-breakpoints";
    await fixture.runtime.execute({ operation: "debug_breakpoints_set", handle: launched.handle, breakpoints: [] });
    phase = "continue";
    await fixture.runtime.execute({ operation: "debug_continue", handle: launched.handle });
    phase = "reject-stale-frame";
    await expect(fixture.runtime.execute({
      operation: "debug_variables",
      handle: launched.handle,
      frameToken: opaqueFrame,
      scope: "locals",
      offset: 0,
      limit: 100,
    })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    phase = "stop";
    await fixture.runtime.execute({ operation: "stop", handle: launched.handle });
  } catch (error) {
    throw new Error(`Phase: ${phase}\n${String(error)}\n${fixture.diagnostics()}`);
  } finally {
    await fixture.close();
  }
}, 60_000);

test("stops an owned runtime when its owner dies while the debugger is paused", async () => {
  const fixture = await createPhase7RuntimeFixture();
  try {
    const launched = await fixture.runtime.launch({ scenePath: "res://debug/debug_fixture.tscn", startupTimeoutMs: 15_000 });
    await fixture.runtime.execute({ operation: "debug_pause", handle: launched.handle });
    expect(fixture.runtimeAlive()).toBe(true);
    await fixture.expireOwnerLease();
    await waitUntil(() => !fixture.runtimeAlive(), 8_000);
    expect(fixture.runtimeAlive(), fixture.diagnostics()).toBe(false);
  } finally {
    await fixture.close();
  }
}, 60_000);

async function expectNativeDapToBeInert(port: number): Promise<void> {
  const socket = connect({ host: "127.0.0.1", port });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting to the inert DAP guard")), 2_000);
    socket.once("connect", () => { clearTimeout(timer); resolve(); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  const request = JSON.stringify({ seq: 1, type: "request", command: "initialize", arguments: {} });
  socket.write(`Content-Length: ${Buffer.byteLength(request, "utf8")}\r\n\r\n${request}`);
  const producedProtocolData = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 250);
    socket.once("data", () => { clearTimeout(timer); resolve(true); });
    socket.once("close", () => { clearTimeout(timer); resolve(false); });
  });
  socket.destroy();
  expect(producedProtocolData).toBe(false);
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
}
