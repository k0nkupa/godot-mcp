import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DapClientError, type DapCommand, type DapStopEvent } from "./dapClient.js";
import { RuntimeService, type RuntimeDapClient } from "./runtimeService.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class FakeDap implements RuntimeDapClient {
  readonly calls: Array<{ command: DapCommand; arguments: Record<string, unknown> }> = [];
  closed = false;
  stopped = true;
  stopSequence = 1;
  transientVariableFailures = 0;

  async request(command: DapCommand, argumentsValue: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push({ command, arguments: argumentsValue });
    if (command === "stackTrace") {
      return { body: { stackFrames: [
        { id: 7, name: "inner", source: { path: "/tmp/project/debug_fixture.gd" }, line: 17, column: 2 },
        { id: 8, name: "outer", source: { path: "/tmp/project/debug_fixture.gd" }, line: 9, column: 1 },
      ] } };
    }
    if (command === "scopes") {
      return { body: { scopes: [
        { name: "Locals", variablesReference: 10 },
        { name: "Members", variablesReference: 20 },
        { name: "Globals", variablesReference: 30 },
      ] } };
    }
    if (command === "variables") {
      if (this.transientVariableFailures > 0) {
        this.transientVariableFailures -= 1;
        throw new DapClientError("TRANSPORT_ERROR", "unknown");
      }
      const reference = Number(argumentsValue.variablesReference);
      if (reference === 10) return { body: { variables: [{ name: "player", type: "Object", value: "Player:<Node#1>", variablesReference: 11 }] } };
      if (reference === 11) return { body: { variables: [{ name: "health", type: "int", value: "100", variablesReference: 0 }] } };
      return { body: { variables: [] } };
    }
    if (command === "setBreakpoints") {
      const breakpoints = Array.isArray(argumentsValue.breakpoints) ? argumentsValue.breakpoints : [];
      return { body: { breakpoints: breakpoints.map((entry, index) => ({ id: index + 1, verified: true, line: (entry as { line: number }).line })) } };
    }
    if (command === "continue" || command === "next" || command === "stepIn") this.stopped = false;
    return { body: {} };
  }

  async nextStop(afterSequence: number): Promise<DapStopEvent> {
    this.stopSequence = Math.max(this.stopSequence + 1, afterSequence + 1);
    this.stopped = true;
    return { sequence: this.stopSequence, reason: "breakpoint", body: { reason: "breakpoint", threadId: 1 } };
  }

  snapshot() {
    return { connected: !this.closed, stopped: this.stopped, stopSequence: this.stopSequence };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

async function debugFixture() {
  const root = await mkdtemp(join(tmpdir(), "godot-mcp-debug-service-"));
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "debug_fixture.gd"), "extends Node\nfunc inner():\n\tpass\n", "utf8");
  const canonicalRoot = await realpath(root);
  const project = {
    projectId: "019f644c-1379-79c0-825e-66a4b7653bd1",
    rootRealPath: canonicalRoot,
    projectConfigSha256: "a".repeat(64),
  };
  const dap = new FakeDap();
  const calls: string[] = [];
  const verifiedPorts: number[] = [];
  const service = new RuntimeService({
    project,
    sessionId: () => "session_12345678",
    createDescriptor: async (input) => ({
      path: join(root, "runtime.json"),
      descriptor: { ...input, secret: "a".repeat(43), launchNonce: "b".repeat(43), createdAtUnixMs: 1, expiresAtUnixMs: 60_001, ownerLeasePath: join(root, "runtime.lease") },
      secret: Buffer.alloc(32),
      cleanup: async () => { calls.push("descriptor.cleanup"); },
    }),
    prepare: async () => { calls.push("prepare"); return { debugPort: 6007, dapPort: 6006, editorPid: 100 }; },
    verifyEditorListener: async (_pid, port) => { verifiedPorts.push(port); calls.push(`verify:${port}`); },
    launchProcess: async () => {
      calls.push("launch");
      return { pid: 42, fingerprint: "42:start", stop: async () => { calls.push("process.stop"); }, wait: async () => new Promise<number>(() => undefined) };
    },
    command: async (operation) => {
      calls.push(operation);
      return operation === "await_ready" ? { pid: 42 } : { ok: true };
    },
    connectDap: async (input) => { calls.push(`dap.connect:${input.port}`); return dap; },
    cleanup: async () => { calls.push("runtime.cleanup"); },
  });
  const launched = await service.launch({ scenePath: "res://runtime/runtime_fixture.tscn", startupTimeoutMs: 5_000 });
  return { calls, dap, launched, project, service, verifiedPorts };
}

describe("Phase 7 RuntimeService debugging", () => {
  it("verifies both editor listeners and attaches DAP only after runtime authentication", async () => {
    const { calls, dap, service, verifiedPorts } = await debugFixture();
    expect(verifiedPorts).toEqual([6007, 6006]);
    expect(calls.indexOf("await_ready")).toBeLessThan(calls.indexOf("dap.connect:6006"));
    expect(dap.calls.slice(0, 2).map((entry) => entry.command)).toEqual(["initialize", "attach"]);
    await service.close();
    expect(dap.closed).toBe(true);
  });

  it("returns bounded stacks, variables, children, and selector watches without evaluation", async () => {
    const { dap, launched, service } = await debugFixture();
    const stack = await service.execute({ operation: "debug_stack", handle: launched.handle, offset: 0, limit: 64 }) as { frames: Array<{ frameToken: string; name: string }> };
    expect(stack.frames.map((frame) => frame.name)).toEqual(["inner", "outer"]);
    const locals = await service.execute({ operation: "debug_variables", handle: launched.handle, frameToken: stack.frames[0]!.frameToken, scope: "locals", offset: 0, limit: 100 }) as { variables: Array<{ variableToken?: string; name: string }> };
    expect(locals.variables[0]).toMatchObject({ name: "player", variableToken: expect.stringMatching(/^dvt_/) });
    const children = await service.execute({ operation: "debug_children", handle: launched.handle, variableToken: locals.variables[0]!.variableToken!, offset: 0, limit: 100 }) as { variables: Array<{ name: string; value: string }> };
    expect(children.variables).toEqual([expect.objectContaining({ name: "health", value: "100" })]);
    const watched = await service.execute({ operation: "debug_watch", handle: launched.handle, frameToken: stack.frames[0]!.frameToken, selectors: [{ scope: "locals", path: ["player", "health"] }] }) as { watches: unknown[] };
    expect(watched.watches).toEqual([expect.objectContaining({ status: "found", variable: expect.objectContaining({ name: "health", value: "100" }) })]);
    expect(dap.calls.map((entry) => entry.command)).not.toContain("evaluate");
    await service.close();
  });

  it("retries Godot's transient unknown response while stack variables are loading", async () => {
    const { dap, launched, service } = await debugFixture();
    const stack = await service.execute({ operation: "debug_stack", handle: launched.handle, offset: 0, limit: 64 }) as { frames: Array<{ frameToken: string }> };
    dap.transientVariableFailures = 2;
    await expect(service.execute({ operation: "debug_variables", handle: launched.handle, frameToken: stack.frames[0]!.frameToken, scope: "locals", offset: 0, limit: 100 })).resolves.toMatchObject({ returned: 1 });
    expect(dap.calls.filter((entry) => entry.command === "variables")).toHaveLength(3);
    await service.close();
  });

  it("invalidates frame tokens on continue and on a new stop event", async () => {
    const { launched, service } = await debugFixture();
    const first = await service.execute({ operation: "debug_stack", handle: launched.handle, offset: 0, limit: 64 }) as { frames: Array<{ frameToken: string }> };
    await service.execute({ operation: "debug_continue", handle: launched.handle });
    await expect(service.execute({ operation: "debug_variables", handle: launched.handle, frameToken: first.frames[0]!.frameToken, scope: "locals", offset: 0, limit: 100 })).rejects.toMatchObject({ code: "STALE_HANDLE" });
    const stopped = await service.execute({ operation: "debug_wait", handle: launched.handle, afterSequence: 1, timeoutMs: 1_000 });
    expect(stopped).toMatchObject({ sequence: 2, reason: "breakpoint" });
    await service.close();
  });

  it("canonicalizes source breakpoints and clears them during cleanup", async () => {
    const { dap, launched, project, service } = await debugFixture();
    const result = await service.execute({
      operation: "debug_breakpoints_set",
      handle: launched.handle,
      breakpoints: [{ sourcePath: "res://debug_fixture.gd", line: 2 }],
    }) as { breakpoints: Array<{ verified: boolean }> };
    expect(result.breakpoints).toEqual([expect.objectContaining({ verified: true })]);
    const set = dap.calls.find((entry) => entry.command === "setBreakpoints");
    expect(set?.arguments).toMatchObject({ source: { path: join(project.rootRealPath, "debug_fixture.gd") }, breakpoints: [{ line: 2 }] });
    await service.close();
    const clears = dap.calls.filter((entry) => entry.command === "setBreakpoints" && Array.isArray(entry.arguments.breakpoints) && entry.arguments.breakpoints.length === 0);
    expect(clears).toHaveLength(1);
  });

  it("rejects duplicate editor listener ports before launching", async () => {
    let launched = false;
    const service = new RuntimeService({
      project: { projectId: "019f644c-1379-79c0-825e-66a4b7653bd1", rootRealPath: "/private/project", projectConfigSha256: "a".repeat(64) },
      sessionId: () => "session_12345678",
      createDescriptor: async (input) => ({
        path: "/private/runtime.json",
        descriptor: { ...input, secret: "a".repeat(43), launchNonce: "b".repeat(43), createdAtUnixMs: 1, expiresAtUnixMs: 60_001, ownerLeasePath: "/private/runtime.lease" },
        secret: Buffer.alloc(32), cleanup: async () => undefined,
      }),
      prepare: async () => ({ debugPort: 6007, dapPort: 6007, editorPid: 100 }),
      launchProcess: async () => { launched = true; throw new Error("must not launch"); },
      command: async () => ({ pid: 42 }),
    });
    await expect(service.launch({ scenePath: "res://runtime/runtime_fixture.tscn", startupTimeoutMs: 5_000 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(launched).toBe(false);
  });
});
