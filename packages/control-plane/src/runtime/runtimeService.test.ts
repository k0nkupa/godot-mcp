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
      wait: async () => 0,
    }),
    command: async (operation) => {
      calls.push(operation);
      return operation === "await_ready" ? { root: "." } : { ok: true };
    },
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
  await service.execute({ operation: "stop", handle: launched.handle });
  expect(service.snapshot().state).toBe("stopped");
  await service.close();
  await service.close();
  expect(calls.filter((call) => call === "process.stop")).toHaveLength(1);
});
