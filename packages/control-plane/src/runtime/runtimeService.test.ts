import { expect, it } from "vitest";

import { RuntimeService } from "./runtimeService.js";

const project = {
  projectId: "019f644c-1379-79c0-825e-66a4b7653bd1",
  rootRealPath: "/private/project",
  projectConfigSha256: "a".repeat(64),
};

it("serializes one runtime generation and rejects stale handles", async () => {
  const calls: string[] = [];
  const service = new RuntimeService({
    project,
    sessionId: () => "session_12345678",
    createDescriptor: async (input) => ({
      path: "/private/runtime/descriptor.json",
      descriptor: { ...input, secret: "a".repeat(43), launchNonce: "b".repeat(43), createdAtUnixMs: 1, expiresAtUnixMs: 60_001 },
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
    command: async (operation) => {
      calls.push(operation);
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
  await expect(service.launch({ scenePath: "res://runtime/runtime_fixture.tscn", startupTimeoutMs: 5_000 })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(service.execute({ operation: "pause", handle: { ...launched.handle, generation: 2 } })).rejects.toMatchObject({ code: "STALE_HANDLE" });
  await service.execute({ operation: "pause", handle: launched.handle });
  expect(service.snapshot().state).toBe("paused");
  await service.execute({ operation: "resume", handle: launched.handle });
  expect(service.snapshot().state).toBe("running");
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
      descriptor: { ...input, secret: "a".repeat(43), launchNonce: "b".repeat(43), createdAtUnixMs: 1, expiresAtUnixMs: 60_001 },
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
      descriptor: { ...input, secret: "a".repeat(43), launchNonce: "b".repeat(43), createdAtUnixMs: 1, expiresAtUnixMs: 60_001 },
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
