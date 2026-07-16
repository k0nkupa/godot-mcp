import { expect, it } from "vitest";

import { RuntimeService } from "./runtimeService.js";

const project = {
  projectId: "019f644c-1379-79c0-825e-66a4b7653bd1",
  rootRealPath: "/private/project",
  projectConfigSha256: "a".repeat(64),
};

it("serializes one runtime generation and rejects stale handles", async () => {
  const calls: string[] = [];
  const timeouts: Array<number | undefined> = [];
  const service = new RuntimeService({
    project,
    sessionId: () => "session_12345678",
    createDescriptor: async (input) => ({
      path: "/private/runtime/descriptor.json",
      descriptor: { ...input, secret: "a".repeat(43), launchNonce: "b".repeat(43), createdAtUnixMs: 1, expiresAtUnixMs: 60_001, ownerLeasePath: "/private/runtime/runtime-owner.lease" },
      secret: Buffer.alloc(32),
      cleanup: async () => undefined,
    }),
    prepare: async () => ({ debugPort: 6007 }),
    launchProcess: async () => ({
      pid: 42,
      fingerprint: "42:start",
      stop: async () => { calls.push("process.stop"); },
      wait: async () => new Promise<number>(() => undefined),
    }),
    command: async (operation, _input, timeoutMs) => {
      calls.push(operation);
      timeouts.push(timeoutMs);
      return operation === "await_ready" ? { pid: 42, root: "." } : { ok: true };
    },
    capture: async (input) => ({
      data: { mimeType: "image/png", width: 1, height: 1, byteLength: 8, sha256: "c".repeat(64), frameIndex: Number(input.frameIndex) },
      binary: new Uint8Array(8),
      binarySha256: "c".repeat(64),
    }),
  });

  const launched = await service.launch({ scenePath: "res://runtime/runtime_fixture.tscn", startupTimeoutMs: 5_000 });
  expect(launched.handle.generation).toBe(1);
  expect(service.snapshot()).toMatchObject({ state: "running", handle: launched.handle });
  await expect(service.execute({ operation: "status", handle: launched.handle })).resolves.toMatchObject({ state: "running", handle: launched.handle });
  expect(calls.at(-1)).toBe("status");
  await expect(service.execute({ operation: "status", handle: { ...launched.handle, generation: 2 } })).rejects.toMatchObject({ code: "STALE_HANDLE" });
  await expect(service.launch({ scenePath: "res://runtime/runtime_fixture.tscn", startupTimeoutMs: 5_000 })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(service.execute({ operation: "pause", handle: { ...launched.handle, generation: 2 } })).rejects.toMatchObject({ code: "STALE_HANDLE" });
  await service.execute({ operation: "pause", handle: launched.handle });
  expect(service.snapshot().state).toBe("paused");
  await service.execute({ operation: "resume", handle: launched.handle });
  expect(service.snapshot().state).toBe("running");
  await service.execute({ operation: "wait", handle: launched.handle, timeoutMs: 30_000, condition: { type: "frames_elapsed", frames: 1 } });
  expect(timeouts.at(-1)).toBe(31_000);
  await expect(service.capture({ handle: launched.handle, maxWidth: 640, maxHeight: 360, frameCount: 2, intervalFrames: 3, advancePaused: false })).resolves.toMatchObject({ frames: [{ metadata: { frameIndex: 0 } }, { metadata: { frameIndex: 1 } }] });
  await service.execute({ operation: "stop", handle: launched.handle });
  expect(service.snapshot().state).toBe("stopped");
  await service.close();
  await service.close();
  expect(calls.filter((call) => call === "process.stop")).toHaveLength(1);
});

it("rejects an authenticated debugger session from a different process", async () => {
  let stopped = false;
  let cleaned = false;
  const service = new RuntimeService({
    project,
    sessionId: () => "session_12345678",
    createDescriptor: async (input) => ({
      path: "/private/runtime/descriptor.json",
      descriptor: { ...input, secret: "a".repeat(43), launchNonce: "b".repeat(43), createdAtUnixMs: 1, expiresAtUnixMs: 60_001, ownerLeasePath: "/private/runtime/runtime-owner.lease" },
      secret: Buffer.alloc(32),
      cleanup: async () => undefined,
    }),
    prepare: async () => ({ debugPort: 6007 }),
    launchProcess: async () => ({ pid: 42, fingerprint: "42:start", stop: async () => { stopped = true; }, wait: async () => new Promise<number>(() => undefined) }),
    command: async () => ({ pid: 99 }),
    cleanup: async () => { cleaned = true; },
  });

  await expect(service.launch({ scenePath: "res://runtime/runtime_fixture.tscn", startupTimeoutMs: 5_000 })).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  expect(stopped).toBe(true);
  expect(cleaned).toBe(true);
});

it("reconciles an unexpected owned-process exit exactly once", async () => {
  let finishProcess: ((exitCode: number) => void) | undefined;
  const processExit = new Promise<number>((resolve) => { finishProcess = resolve; });
  let cleanupCalls = 0;
  const service = new RuntimeService({
    project,
    sessionId: () => "session_12345678",
    createDescriptor: async (input) => ({
      path: "/private/runtime/descriptor.json",
      descriptor: { ...input, secret: "a".repeat(43), launchNonce: "b".repeat(43), createdAtUnixMs: 1, expiresAtUnixMs: 60_001, ownerLeasePath: "/private/runtime/runtime-owner.lease" },
      secret: Buffer.alloc(32),
      cleanup: async () => undefined,
    }),
    prepare: async () => ({ debugPort: 6007 }),
    launchProcess: async () => ({ pid: 42, fingerprint: "42:start", stop: async () => undefined, wait: async () => processExit }),
    command: async (operation) => operation === "await_ready" ? { pid: 42 } : { ok: true },
    cleanup: async () => { cleanupCalls += 1; },
  });

  await service.launch({ scenePath: "res://runtime/runtime_fixture.tscn", startupTimeoutMs: 5_000 });
  finishProcess?.(17);
  for (let attempt = 0; attempt < 20 && service.snapshot().state !== "stopped"; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  expect(service.snapshot().state).toBe("stopped");
  await service.close();
  expect(cleanupCalls).toBe(1);
});

it("cleans the owned process when cooperative stop fails", async () => {
  let stopped = false;
  const service = new RuntimeService({
    project,
    sessionId: () => "session_12345678",
    createDescriptor: async (input) => ({
      path: "/private/runtime/descriptor.json",
      descriptor: { ...input, secret: "a".repeat(43), launchNonce: "b".repeat(43), createdAtUnixMs: 1, expiresAtUnixMs: 60_001, ownerLeasePath: "/private/runtime/runtime-owner.lease" },
      secret: Buffer.alloc(32), cleanup: async () => undefined,
    }),
    prepare: async () => ({ debugPort: 6007 }),
    launchProcess: async () => ({ pid: 42, fingerprint: "42:start", stop: async () => { stopped = true; }, wait: async () => new Promise<number>(() => undefined) }),
    command: async (operation) => {
      if (operation === "await_ready") return { pid: 42 };
      throw new Error("cooperative stop failed");
    },
  });
  const launched = await service.launch({ scenePath: "res://runtime/runtime_fixture.tscn", startupTimeoutMs: 5_000 });
  await expect(service.execute({ operation: "stop", handle: launched.handle })).rejects.toThrow("cooperative stop failed");
  expect(stopped).toBe(true);
  expect(service.snapshot().state).toBe("stopped");
});

it("blocks relaunch when owned-process cleanup fails", async () => {
  const service = new RuntimeService({
    project,
    sessionId: () => "session_12345678",
    createDescriptor: async (input) => ({
      path: "/private/runtime/descriptor.json",
      descriptor: { ...input, secret: "a".repeat(43), launchNonce: "b".repeat(43), createdAtUnixMs: 1, expiresAtUnixMs: 60_001, ownerLeasePath: "/private/runtime/runtime-owner.lease" },
      secret: Buffer.alloc(32), cleanup: async () => undefined,
    }),
    prepare: async () => ({ debugPort: 6007 }),
    launchProcess: async () => ({ pid: 42, fingerprint: "42:start", stop: async () => { throw new Error("fingerprint changed"); }, wait: async () => new Promise<number>(() => undefined) }),
    command: async (operation) => operation === "await_ready" ? { pid: 42 } : { stopping: true },
  });
  const launched = await service.launch({ scenePath: "res://runtime/runtime_fixture.tscn", startupTimeoutMs: 5_000 });
  await expect(service.execute({ operation: "stop", handle: launched.handle })).rejects.toThrow("fingerprint changed");
  expect(service.snapshot().state).toBe("failed");
  await expect(service.launch({ scenePath: "res://runtime/runtime_fixture.tscn", startupTimeoutMs: 5_000 })).rejects.toMatchObject({ code: "CONFLICT" });
});

it("cancels an in-progress launch before shutdown returns", async () => {
  let releasePrepare: (() => void) | undefined;
  const prepareBlocked = new Promise<void>((resolve) => { releasePrepare = resolve; });
  let launchCalls = 0;
  const service = new RuntimeService({
    project,
    sessionId: () => "session_12345678",
    createDescriptor: async (input) => ({
      path: "/private/runtime/descriptor.json",
      descriptor: { ...input, secret: "a".repeat(43), launchNonce: "b".repeat(43), createdAtUnixMs: 1, expiresAtUnixMs: 60_001, ownerLeasePath: "/private/runtime/runtime-owner.lease" },
      secret: Buffer.alloc(32), cleanup: async () => undefined,
    }),
    prepare: async () => { await prepareBlocked; return { debugPort: 6007 }; },
    launchProcess: async () => {
      launchCalls += 1;
      return { pid: 42, fingerprint: "42:start", stop: async () => undefined, wait: async () => new Promise<number>(() => undefined) };
    },
    command: async () => ({ pid: 42 }),
  });

  const launching = service.launch({ scenePath: "res://runtime/runtime_fixture.tscn", startupTimeoutMs: 5_000 });
  const closing = service.close();
  releasePrepare?.();
  await expect(launching).rejects.toMatchObject({ code: "CONFLICT" });
  await closing;
  expect(launchCalls).toBe(0);
  expect(service.snapshot().state).toBe("stopped");
  await expect(service.launch({ scenePath: "res://runtime/runtime_fixture.tscn", startupTimeoutMs: 5_000 })).rejects.toMatchObject({ code: "CONFLICT" });
});

it("cleans every generation across editor disconnects", async () => {
  let stopCalls = 0;
  let nextPid = 41;
  const service = new RuntimeService({
    project,
    sessionId: () => "session_12345678",
    createDescriptor: async (input) => ({
      path: `/private/runtime/descriptor-${input.generation}.json`,
      descriptor: { ...input, secret: "a".repeat(43), launchNonce: "b".repeat(43), createdAtUnixMs: 1, expiresAtUnixMs: 60_001, ownerLeasePath: "/private/runtime/runtime-owner.lease" },
      secret: Buffer.alloc(32), cleanup: async () => undefined,
    }),
    prepare: async () => ({ debugPort: 6007 }),
    launchProcess: async () => {
      const pid = ++nextPid;
      return { pid, fingerprint: `${pid}:start`, stop: async () => { stopCalls += 1; }, wait: async () => new Promise<number>(() => undefined) };
    },
    command: async (operation) => operation === "await_ready" ? { pid: nextPid } : { ok: true },
  });

  await service.launch({ scenePath: "res://runtime/runtime_fixture.tscn", startupTimeoutMs: 5_000 });
  await service.disconnect();
  await service.launch({ scenePath: "res://runtime/runtime_fixture.tscn", startupTimeoutMs: 5_000 });
  await service.disconnect();
  expect(stopCalls).toBe(2);
  expect(service.snapshot().state).toBe("stopped");
});

it("retries debugger cleanup after reconnect before preparing a new runtime", async () => {
  let attached = true;
  let cleanupCalls = 0;
  let nextPid = 41;
  const calls: string[] = [];
  const service = new RuntimeService({
    project,
    sessionId: () => attached ? "session_12345678" : null,
    createDescriptor: async (input) => ({
      path: `/private/runtime/descriptor-${input.generation}.json`,
      descriptor: { ...input, secret: "a".repeat(43), launchNonce: "b".repeat(43), createdAtUnixMs: 1, expiresAtUnixMs: 60_001, ownerLeasePath: "/private/runtime/runtime-owner.lease" },
      secret: Buffer.alloc(32), cleanup: async () => undefined,
    }),
    prepare: async () => { calls.push("prepare"); return { debugPort: 6007 }; },
    launchProcess: async () => {
      const pid = ++nextPid;
      return { pid, fingerprint: `${pid}:start`, stop: async () => undefined, wait: async () => new Promise<number>(() => undefined) };
    },
    command: async (operation) => operation === "await_ready" ? { pid: nextPid } : { ok: true },
    cleanup: async () => {
      cleanupCalls += 1;
      calls.push("cleanup");
      if (!attached) throw new Error("disconnected");
    },
  });

  await service.launch({ scenePath: "res://runtime/runtime_fixture.tscn", startupTimeoutMs: 5_000 });
  attached = false;
  await service.disconnect();
  attached = true;
  calls.length = 0;
  await service.launch({ scenePath: "res://runtime/runtime_fixture.tscn", startupTimeoutMs: 5_000 });
  expect(calls.slice(0, 2)).toEqual(["cleanup", "prepare"]);
  expect(cleanupCalls).toBe(2);
  await service.disconnect();
});

it("does not publish running after the owned process exits during authentication", async () => {
  let finishProcess: ((exitCode: number) => void) | undefined;
  const processExit = new Promise<number>((resolve) => { finishProcess = resolve; });
  let commandStarted: (() => void) | undefined;
  const commandEntered = new Promise<void>((resolve) => { commandStarted = resolve; });
  let releaseReady: (() => void) | undefined;
  const readyBlocked = new Promise<void>((resolve) => { releaseReady = resolve; });
  const service = new RuntimeService({
    project,
    sessionId: () => "session_12345678",
    createDescriptor: async (input) => ({
      path: "/private/runtime/descriptor.json",
      descriptor: { ...input, secret: "a".repeat(43), launchNonce: "b".repeat(43), createdAtUnixMs: 1, expiresAtUnixMs: 60_001, ownerLeasePath: "/private/runtime/runtime-owner.lease" },
      secret: Buffer.alloc(32), cleanup: async () => undefined,
    }),
    prepare: async () => ({ debugPort: 6007 }),
    launchProcess: async () => ({ pid: 42, fingerprint: "42:start", stop: async () => undefined, wait: async () => processExit }),
    command: async () => {
      commandStarted?.();
      await readyBlocked;
      return { pid: 42 };
    },
  });

  const launching = service.launch({ scenePath: "res://runtime/runtime_fixture.tscn", startupTimeoutMs: 5_000 });
  await commandEntered;
  finishProcess?.(0);
  for (let attempt = 0; attempt < 20 && service.snapshot().state !== "stopped"; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  releaseReady?.();
  await expect(launching).rejects.toMatchObject({ code: "GODOT_RUNTIME_ERROR" });
  expect(service.snapshot().state).not.toBe("running");
});

it("retains a failed descriptor cleanup for a later close retry", async () => {
  let cleanupCalls = 0;
  const service = new RuntimeService({
    project,
    sessionId: () => "session_12345678",
    createDescriptor: async (input) => ({
      path: "/private/runtime/descriptor.json",
      descriptor: { ...input, secret: "a".repeat(43), launchNonce: "b".repeat(43), createdAtUnixMs: 1, expiresAtUnixMs: 60_001, ownerLeasePath: "/private/runtime/runtime-owner.lease" },
      secret: Buffer.alloc(32),
      cleanup: async () => {
        cleanupCalls += 1;
        if (cleanupCalls === 1) throw new Error("transient delete failure");
      },
    }),
    prepare: async () => { throw new Error("prepare failed"); },
    command: async () => ({ ok: true }),
  });

  await expect(service.launch({ scenePath: "res://runtime/runtime_fixture.tscn", startupTimeoutMs: 5_000 })).rejects.toThrow("transient delete failure");
  await expect(service.close()).resolves.toBeUndefined();
  expect(cleanupCalls).toBe(2);
  expect(service.snapshot().state).toBe("stopped");
});
