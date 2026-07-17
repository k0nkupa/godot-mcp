import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GodotMcpException } from "../errors.js";
import { DebuggerClientError, type DebuggerCommand, type DebuggerStopEvent } from "./debuggerClient.js";
import { RuntimeService, type RuntimeDebuggerClient } from "./runtimeService.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class FakeDebuggerClient implements RuntimeDebuggerClient {
  readonly calls: Array<{ command: DebuggerCommand; arguments: Record<string, unknown> }> = [];
  closed = false;
  stopped = true;
  stopSequence = 1;
  transientVariableFailures = 0;
  variablePageSize = 0;
  variablePageTruncated = false;
  outOfRangePages = false;
  deepVariables = false;
  typedWatchVariables = false;
  failBreakpointPath: string | null = null;
  readonly persistentBreakpointFailures = new Set<string>();
  terminalNotAttached = false;

  async request(command: DebuggerCommand, argumentsValue: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.terminalNotAttached) {
      throw new GodotMcpException({
        code: "NOT_ATTACHED",
        message: "Authenticated debugger session is unavailable",
        retryable: true,
        correlationId: "terminal-cleanup",
        partialEffects: false,
        rollback: "not_needed",
      });
    }
    this.calls.push({ command, arguments: argumentsValue });
    if (command === "stackTrace") {
      if (this.outOfRangePages && Number(argumentsValue.startFrame) > 0) {
        return { body: { stackFrames: [], totalFrames: 3 } };
      }
      return { body: { stackFrames: [
        { id: 7, name: "inner", source: { path: "/tmp/project/debug_fixture.gd" }, line: 17, column: 2 },
        { id: 8, name: "outer", source: { path: "/tmp/project/debug_fixture.gd" }, line: 9, column: 1 },
      ], totalFrames: 12 } };
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
        throw new DebuggerClientError("TRANSPORT_ERROR", "unknown");
      }
      const reference = Number(argumentsValue.variablesReference);
      if (this.outOfRangePages && Number(argumentsValue.start) > 0) {
        return { body: { variables: [], totalVariables: 1 } };
      }
      if (this.variablePageSize > 0) {
        return { body: {
          variables: Array.from({ length: this.variablePageSize }, (_, index) => ({ name: index === 0 ? "target" : `filler_${index}`, value: String(index), variablesReference: 0 })),
          truncated: this.variablePageTruncated,
        } };
      }
      if (reference === 10 && this.typedWatchVariables) return { body: { variables: [
        { name: "container", selectorKind: "string", selectorValue: "container", type: "Dictionary", value: "Dictionary(size=2)", variablesReference: 12 },
      ] } };
      if (reference === 12 && this.typedWatchVariables) return { body: { variables: [
        { name: "0", selectorKind: "string", selectorValue: "0", type: "String", value: "string-key", variablesReference: 0 },
        { name: "0", selectorKind: "number", selectorValue: 0, type: "String", value: "numeric-key", variablesReference: 0 },
      ] } };
      if (reference === 10) return { body: { variables: [{ name: "player", selectorKind: "string", selectorValue: "player", type: "Object", value: "Player:<Node#1>", variablesReference: 11 }], totalVariables: 256, truncated: true } };
      if (this.deepVariables && reference >= 11) return { body: { variables: [{ name: "child", type: "Dictionary", value: "Dictionary(size=1)", variablesReference: reference + 1 }] } };
      if (reference === 11) return { body: { variables: [{ name: "health", selectorKind: "string", selectorValue: "health", type: "int", value: "100", valueTruncated: true, variablesReference: 0 }] } };
      return { body: { variables: [] } };
    }
    if (command === "setBreakpoints") {
      const sourcePath = (argumentsValue.source as { path?: unknown } | undefined)?.path;
      if (typeof sourcePath === "string" && (sourcePath === this.failBreakpointPath || this.persistentBreakpointFailures.has(sourcePath))) {
        this.failBreakpointPath = null;
        throw new DebuggerClientError("TRANSPORT_ERROR", "setBreakpoints failed");
      }
      const breakpoints = Array.isArray(argumentsValue.breakpoints) ? argumentsValue.breakpoints : [];
      return { body: { breakpoints: breakpoints.map((entry, index) => ({ id: index + 1, verified: true, line: (entry as { line: number }).line })) } };
    }
    if (command === "pause") this.stopped = true;
    if (command === "continue" || command === "next" || command === "stepIn") this.stopped = false;
    return { body: {} };
  }

  async nextStop(afterSequence: number): Promise<DebuggerStopEvent> {
    this.stopSequence = Math.max(this.stopSequence + 1, afterSequence + 1);
    this.stopped = true;
    return { sequence: this.stopSequence, reason: "breakpoint", body: { reason: "breakpoint", threadId: 1 } };
  }

  snapshot() {
    return { connected: !this.closed, stopped: this.stopped, stopSequence: this.stopSequence };
  }

  markRunning(): void {
    this.stopped = false;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

async function debugFixture() {
  const root = await mkdtemp(join(tmpdir(), "godot-mcp-debug-service-"));
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "debug_fixture.gd"), "extends Node\nfunc inner():\n\tpass\n", "utf8");
  await writeFile(join(root, "debug_fixture_two.gd"), "extends Node\nfunc other():\n\tpass\n", "utf8");
  const addonDirectory = join(root, "addons/godot_mcp");
  await mkdir(addonDirectory, { recursive: true });
  const protectedScript = join(addonDirectory, "protected.gd");
  await writeFile(protectedScript, "extends Node\n", "utf8");
  await symlink(protectedScript, join(root, "debug_alias.gd"));
  const canonicalRoot = await realpath(root);
  const project = {
    projectId: "019f644c-1379-79c0-825e-66a4b7653bd1",
    rootRealPath: canonicalRoot,
    projectConfigSha256: "a".repeat(64),
  };
  const dap = new FakeDebuggerClient();
  const calls: string[] = [];
  const binding = { debuggerSessionId: 7, activeSessionCount: 1, unambiguous: true };
  const verifiedPorts: number[] = [];
  const service = new RuntimeService({
    project,
    sessionId: () => "session_12345678",
    requireAuthenticatedDebuggerMetadata: true,
    createDescriptor: async (input) => ({
      path: join(root, "runtime.json"),
      descriptor: { ...input, secret: "a".repeat(43), launchNonce: "b".repeat(43), createdAtUnixMs: 1, expiresAtUnixMs: 60_001, ownerLeasePath: join(root, "runtime.lease") },
      secret: Buffer.alloc(32),
      cleanup: async () => { calls.push("descriptor.cleanup"); },
    }),
    prepare: async () => { calls.push("prepare"); return { debugPort: 6007, editorPid: 100, debugTransport: "authenticated-editor-session" }; },
    verifyEditorListener: async (_pid, port) => { verifiedPorts.push(port); calls.push(`verify:${port}`); },
    launchProcess: async () => {
      calls.push("launch");
      return { pid: 42, fingerprint: "42:start", stop: async () => { calls.push("process.stop"); }, wait: async () => new Promise<number>(() => undefined) };
    },
    command: async (operation, input) => {
      calls.push(operation);
      if (operation === "await_ready") return { pid: 42, debuggerSessionId: 7 };
      if (operation === "debug_binding_status") return { ...binding };
      if (operation === "debug_adapter") {
        const command = String(input.command);
        const adapterArguments = (input.adapterArguments ?? {}) as Record<string, unknown>;
        if (command === "status") return dap.snapshot();
        if (command === "wait") return dap.nextStop(Number(adapterArguments.afterSequence ?? 0));
        return dap.request(command as DebuggerCommand, adapterArguments);
      }
      return { ok: true };
    },
    cleanup: async () => { calls.push("runtime.cleanup"); },
  });
  const launched = await service.launch({ scenePath: "res://runtime/runtime_fixture.tscn", startupTimeoutMs: 5_000 });
  return { binding, calls, dap, launched, project, service, verifiedPorts };
}

describe("Phase 7 RuntimeService debugging", () => {
  it("uses the authenticated editor debugger channel only after runtime authentication", async () => {
    const { calls, dap, service, verifiedPorts } = await debugFixture();
    expect(verifiedPorts).toEqual([6007]);
    expect(calls).toContain("await_ready");
    expect(dap.calls.map((entry) => entry.command)).not.toContain("attach");
    await service.close();
    expect(calls).toContain("runtime.cleanup");
    expect(calls.indexOf("process.stop")).toBeLessThan(calls.indexOf("runtime.cleanup"));
  });

  it("returns bounded stacks, variables, children, and selector watches without evaluation", async () => {
    const { dap, launched, service } = await debugFixture();
    const stack = await service.execute({ operation: "debug_stack", handle: launched.handle, offset: 0, limit: 64 }) as { frames: Array<{ frameToken: string; name: string }>; totalFrames: number };
    const opaqueFrame = stack.frames[0]!.frameToken;
    expect(stack.frames.map((frame) => frame.name)).toEqual(["inner", "outer"]);
    expect(stack.totalFrames).toBe(12);
    const locals = await service.execute({
      operation: "debug_variables",
      handle: launched.handle,
      frameToken: opaqueFrame,
      scope: "locals",
      offset: 0,
      limit: 100,
    }) as { variables: Array<{ variableToken?: string; name: string }>; total: number; truncated: boolean };
    expect(locals.variables[0]).toMatchObject({ name: "player", variableToken: expect.stringMatching(/^dvt_/) });
    expect(locals).toMatchObject({ total: 256, truncated: true });
    const opaqueVariable = locals.variables[0]!.variableToken!;
    const variableReference = { ["variableToken"]: opaqueVariable };
    const children = await service.execute({
      operation: "debug_children",
      handle: launched.handle,
      ...variableReference,
      offset: 0,
      limit: 100,
    }) as { variables: Array<{ name: string; value: string; valueTruncated: boolean }> };
    expect(children.variables).toEqual([expect.objectContaining({ name: "health", value: "100", valueTruncated: true })]);
    const watched = await service.execute({
      operation: "debug_watch",
      handle: launched.handle,
      frameToken: opaqueFrame,
      selectors: [{ scope: "locals", path: ["player", "health"] }],
    }) as { watches: unknown[] };
    expect(watched.watches).toEqual([expect.objectContaining({ status: "found", variable: expect.objectContaining({ name: "health", value: "100" }) })]);
    expect(dap.calls.map((entry) => entry.command)).not.toContain("evaluate");
    await service.close();
  });

  it("returns stack variables synchronously over the authenticated channel", async () => {
    const { dap, launched, service } = await debugFixture();
    const stack = await service.execute({ operation: "debug_stack", handle: launched.handle, offset: 0, limit: 64 }) as { frames: Array<{ frameToken: string }> };
    const opaqueFrame = stack.frames[0]!.frameToken;
    await expect(service.execute({
      operation: "debug_variables",
      handle: launched.handle,
      frameToken: opaqueFrame,
      scope: "locals",
      offset: 0,
      limit: 100,
    })).resolves.toMatchObject({ returned: 1 });
    expect(dap.calls.filter((entry) => entry.command === "variables")).toHaveLength(1);
    await service.close();
  });

  it("preserves reported totals for offsets beyond the available page", async () => {
    const { dap, launched, service } = await debugFixture();
    dap.outOfRangePages = true;
    await expect(service.execute({ operation: "debug_stack", handle: launched.handle, offset: 64, limit: 64 }))
      .resolves.toMatchObject({ frames: [], totalFrames: 3 });
    const stack = await service.execute({ operation: "debug_stack", handle: launched.handle, offset: 0, limit: 64 }) as { frames: Array<{ frameToken: string }> };
    await expect(service.execute({
      operation: "debug_variables",
      handle: launched.handle,
      frameToken: stack.frames[0]!.frameToken,
      scope: "locals",
      offset: 2_048,
      limit: 100,
    })).resolves.toMatchObject({ variables: [], total: 1, truncated: false });
    await service.close();
  });

  it("invalidates frame tokens on continue and on a new stop event", async () => {
    const { launched, service } = await debugFixture();
    const first = await service.execute({ operation: "debug_stack", handle: launched.handle, offset: 0, limit: 64 }) as { frames: Array<{ frameToken: string }> };
    const opaqueFrame = first.frames[0]!.frameToken;
    await service.execute({ operation: "debug_continue", handle: launched.handle });
    await expect(service.execute({
      operation: "debug_variables",
      handle: launched.handle,
      frameToken: opaqueFrame,
      scope: "locals",
      offset: 0,
      limit: 100,
    })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const stopped = await service.execute({ operation: "debug_wait", handle: launched.handle, afterSequence: 1, timeoutMs: 1_000 });
    expect(stopped).toEqual({ sequence: 2, reason: "breakpoint" });
    await service.close();
  });

  it("invalidates tokens across externally observed continue and stop transitions", async () => {
    const { dap, launched, service } = await debugFixture();
    const first = await service.execute({ operation: "debug_stack", handle: launched.handle, offset: 0, limit: 64 }) as { frames: Array<{ frameToken: string }> };
    const opaqueFrame = first.frames[0]!.frameToken;
    dap.stopped = false;
    await expect(service.execute({ operation: "debug_status", handle: launched.handle })).resolves.toMatchObject({ stopped: false });
    await expect(service.execute({
      operation: "debug_variables", handle: launched.handle, frameToken: opaqueFrame, scope: "locals", offset: 0, limit: 100,
    })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    dap.stopped = true;
    await expect(service.execute({
      operation: "debug_variables", handle: launched.handle, frameToken: opaqueFrame, scope: "locals", offset: 0, limit: 100,
    })).rejects.toMatchObject({ code: "STALE_HANDLE" });
  });

  it("reuses frame references across repeated stack reads at one stop", async () => {
    const { launched, service } = await debugFixture();
    const first = await service.execute({ operation: "debug_stack", handle: launched.handle, offset: 0, limit: 64 }) as { frames: Array<{ frameToken: string }> };
    const second = await service.execute({ operation: "debug_stack", handle: launched.handle, offset: 0, limit: 64 }) as { frames: Array<{ frameToken: string }> };
    expect(second.frames.map((frame) => frame.frameToken)).toEqual(first.frames.map((frame) => frame.frameToken));
  });

  it("reports disconnected debugger status without requiring an active debugger transport", async () => {
    const { dap, launched, service } = await debugFixture();
    dap.closed = true;
    await expect(service.execute({ operation: "debug_status", handle: launched.handle })).resolves.toMatchObject({ connected: false, stopped: true });
  });

  it("treats terminal debugger detachment as successful runtime cleanup", async () => {
    const { dap, launched, service } = await debugFixture();
    dap.terminalNotAttached = true;
    await expect(service.execute({ operation: "stop", handle: launched.handle })).resolves.toMatchObject({ state: "stopped" });
  });

  it("fails closed when the authenticated runtime is not the only active debugger session", async () => {
    const { binding, launched, service } = await debugFixture();
    binding.activeSessionCount = 2;
    binding.unambiguous = false;
    await expect(service.execute({ operation: "debug_status", handle: launched.handle })).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("enforces pause and continue state preconditions before changing tokens", async () => {
    const { dap, launched, service } = await debugFixture();
    await expect(service.execute({ operation: "debug_pause", handle: launched.handle })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    dap.stopped = false;
    await expect(service.execute({ operation: "debug_continue", handle: launched.handle })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(service.execute({ operation: "debug_pause", handle: launched.handle })).resolves.toMatchObject({ stopped: true });
  });

  it("charges every watch page against the shared per-stop variable budget", async () => {
    const { dap, launched, service } = await debugFixture();
    const stack = await service.execute({ operation: "debug_stack", handle: launched.handle, offset: 0, limit: 64 }) as { frames: Array<{ frameToken: string }> };
    const opaqueFrame = stack.frames[0]!.frameToken;
    dap.variablePageSize = 256;
    await expect(service.execute({
      operation: "debug_watch",
      handle: launched.handle,
      frameToken: opaqueFrame,
      selectors: Array.from({ length: 9 }, () => ({ scope: "locals" as const, path: ["target"] })),
    })).rejects.toThrow(/variable entry limit exceeded/i);
  });

  it("reports a watch miss as truncated when the authenticated runtime omitted later entries", async () => {
    const { dap, launched, service } = await debugFixture();
    const stack = await service.execute({ operation: "debug_stack", handle: launched.handle, offset: 0, limit: 64 }) as { frames: Array<{ frameToken: string }> };
    const opaqueFrame = stack.frames[0]!.frameToken;
    dap.variablePageSize = 256;
    dap.variablePageTruncated = true;
    await expect(service.execute({
      operation: "debug_watch", handle: launched.handle, ["frameToken"]: opaqueFrame,
      selectors: [{ scope: "locals", path: ["beyond_page"] }],
    })).resolves.toMatchObject({ watches: [{ status: "truncated" }] });
  });

  it("preserves selector segment types while resolving dictionary keys", async () => {
    const { dap, launched, service } = await debugFixture();
    dap.typedWatchVariables = true;
    const stack = await service.execute({ operation: "debug_stack", handle: launched.handle, offset: 0, limit: 64 }) as { frames: Array<{ frameToken: string }> };
    const watched = await service.execute({
      operation: "debug_watch",
      handle: launched.handle,
      ["frameToken"]: stack.frames[0]!.frameToken,
      selectors: [
        { scope: "locals", path: ["container", 0] },
        { scope: "locals", path: ["container", "0"] },
      ],
    }) as { watches: Array<{ variable: { value: string } }> };
    expect(watched.watches.map((watch) => watch.variable.value)).toEqual(["numeric-key", "string-key"]);
  });

  it("retains hasChildren without issuing an unusable token at the maximum depth", async () => {
    const { dap, launched, service } = await debugFixture();
    dap.deepVariables = true;
    const stack = await service.execute({ operation: "debug_stack", handle: launched.handle, offset: 0, limit: 64 }) as { frames: Array<{ frameToken: string }> };
    const opaqueFrame = stack.frames[0]!.frameToken;
    const locals = await service.execute({
      operation: "debug_variables", handle: launched.handle, ["frameToken"]: opaqueFrame,
      scope: "locals", offset: 0, limit: 1,
    }) as { variables: Array<{ variableToken?: string }> };
    let cursorReference = locals.variables[0]!.variableToken!;
    let deepest: { variables: Array<{ variableToken?: string; hasChildren: boolean; expandable: boolean }> } | undefined;
    for (let depth = 2; depth <= 8; depth += 1) {
      deepest = await service.execute({ operation: "debug_children", handle: launched.handle, ["variableToken"]: cursorReference, offset: 0, limit: 1 }) as typeof deepest;
      if (depth < 8) cursorReference = deepest!.variables[0]!.variableToken!;
    }
    expect(deepest!.variables[0]).toMatchObject({ hasChildren: true, expandable: false });
    expect(deepest!.variables[0]).not.toHaveProperty("variableToken");
  });

  it("canonicalizes source breakpoints and clears them during cleanup", async () => {
    const { dap, launched, project, service } = await debugFixture();
    const result = await service.execute({
      operation: "debug_breakpoints_set",
      handle: launched.handle,
      breakpoints: [{ sourcePath: "res://debug_fixture.gd", line: 2 }, { sourcePath: "res://debug_fixture.gd", line: 3 }],
    }) as { breakpoints: Array<{ verified: boolean }> };
    expect(result.breakpoints).toHaveLength(2);
    const set = dap.calls.find((entry) => entry.command === "setBreakpoints");
    expect(set?.arguments).toMatchObject({ source: { path: join(project.rootRealPath, "debug_fixture.gd") }, breakpoints: [{ line: 2 }, { line: 3 }] });
    await expect(service.execute({ operation: "debug_status", handle: launched.handle })).resolves.toMatchObject({ breakpointCount: 2 });
    await service.close();
    const clears = dap.calls.filter((entry) => entry.command === "setBreakpoints" && Array.isArray(entry.arguments.breakpoints) && entry.arguments.breakpoints.length === 0);
    expect(clears).toHaveLength(1);
  });

  it("rolls back already-applied sources when breakpoint replacement fails", async () => {
    const { dap, launched, project, service } = await debugFixture();
    await service.execute({
      operation: "debug_breakpoints_set",
      handle: launched.handle,
      breakpoints: [{ sourcePath: "res://debug_fixture.gd", line: 2 }],
    });
    dap.failBreakpointPath = join(project.rootRealPath, "debug_fixture_two.gd");
    await expect(service.execute({
      operation: "debug_breakpoints_set",
      handle: launched.handle,
      breakpoints: [
        { sourcePath: "res://debug_fixture.gd", line: 3 },
        { sourcePath: "res://debug_fixture_two.gd", line: 2 },
      ],
    })).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
    const sourceOneCalls = dap.calls.filter((entry) =>
      entry.command === "setBreakpoints"
      && (entry.arguments.source as { path?: string }).path === join(project.rootRealPath, "debug_fixture.gd"));
    expect(sourceOneCalls.at(-1)?.arguments.breakpoints).toEqual([{ line: 2 }]);
    const sourceTwoCalls = dap.calls.filter((entry) =>
      entry.command === "setBreakpoints"
      && (entry.arguments.source as { path?: string }).path === join(project.rootRealPath, "debug_fixture_two.gd"));
    expect(sourceTwoCalls.at(-1)?.arguments.breakpoints).toEqual([]);
    await expect(service.execute({ operation: "debug_status", handle: launched.handle })).resolves.toMatchObject({ breakpointCount: 1 });
  });

  it("terminates and cleans the run when breakpoint rollback also fails", async () => {
    const { calls, dap, launched, project, service } = await debugFixture();
    await service.execute({
      operation: "debug_breakpoints_set",
      handle: launched.handle,
      breakpoints: [{ sourcePath: "res://debug_fixture.gd", line: 2 }],
    });
    dap.persistentBreakpointFailures.add(join(project.rootRealPath, "debug_fixture_two.gd"));
    await expect(service.execute({
      operation: "debug_breakpoints_set",
      handle: launched.handle,
      breakpoints: [
        { sourcePath: "res://debug_fixture.gd", line: 3 },
        { sourcePath: "res://debug_fixture_two.gd", line: 2 },
      ],
    })).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
    expect(calls).toContain("process.stop");
    expect(calls).toContain("runtime.cleanup");
    expect(service.snapshot().state).toBe("failed");
  });

  it("rejects a breakpoint whose resolved path aliases the protected addon", async () => {
    const { dap, launched, service } = await debugFixture();
    await expect(service.execute({
      operation: "debug_breakpoints_set",
      handle: launched.handle,
      breakpoints: [{ sourcePath: "res://debug_alias.gd", line: 1 }],
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(dap.calls.filter((entry) => entry.command === "setBreakpoints")).toHaveLength(0);
  });

  it("requires authenticated debugger metadata when the production launch contract enables debugging", async () => {
    let launched = false;
    const service = new RuntimeService({
      project: { projectId: "019f644c-1379-79c0-825e-66a4b7653bd1", rootRealPath: "/private/project", projectConfigSha256: "a".repeat(64) },
      sessionId: () => "session_12345678",
      requireAuthenticatedDebuggerMetadata: true,
      createDescriptor: async (input) => ({
        path: "/private/runtime.json",
        descriptor: { ...input, secret: "a".repeat(43), launchNonce: "b".repeat(43), createdAtUnixMs: 1, expiresAtUnixMs: 60_001, ownerLeasePath: "/private/runtime.lease" },
        secret: Buffer.alloc(32), cleanup: async () => undefined,
      }),
      prepare: async () => ({ debugPort: 6007 }),
      launchProcess: async () => { launched = true; throw new Error("must not launch"); },
      command: async () => ({ pid: 42 }),
    });
    await expect(service.launch({ scenePath: "res://runtime/runtime_fixture.tscn", startupTimeoutMs: 5_000 })).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect(launched).toBe(false);
  });

  it("rejects an editor process that did not disable its unauthenticated DAP transport", async () => {
    let launched = false;
    const service = new RuntimeService({
      project: { projectId: "019f644c-1379-79c0-825e-66a4b7653bd1", rootRealPath: "/private/project", projectConfigSha256: "a".repeat(64) },
      sessionId: () => "session_12345678",
      requireAuthenticatedDebuggerMetadata: true,
      createDescriptor: async (input) => ({
        path: "/private/runtime.json",
        descriptor: { ...input, secret: "a".repeat(43), launchNonce: "b".repeat(43), createdAtUnixMs: 1, expiresAtUnixMs: 60_001, ownerLeasePath: "/private/runtime.lease" },
        secret: Buffer.alloc(32), cleanup: async () => undefined,
      }),
      prepare: async () => ({ debugPort: 6007, editorPid: 100 }),
      launchProcess: async () => { launched = true; throw new Error("must not launch"); },
      command: async () => ({ pid: 42 }),
    });
    await expect(service.launch({ scenePath: "res://runtime/runtime_fixture.tscn", startupTimeoutMs: 5_000 })).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect(launched).toBe(false);
  });
});
