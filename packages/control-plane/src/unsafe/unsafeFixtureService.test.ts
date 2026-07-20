import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { copyFixture } from "@godot-mcp/testkit";
import { expect, it, test } from "vitest";

import { UnsafeFixtureProcess, type UnsafeFixtureProcessHandle } from "./unsafeFixtureProcess.js";
import { UnsafeFixtureService } from "./unsafeFixtureService.js";

function activation(copyRoot: string) {
  return { schemaVersion: 1 as const, registrationId: crypto.randomUUID(), instanceId: crypto.randomUUID(), copyRoot, projectSha256: "a".repeat(64), markerNonceSha256: "b".repeat(64), ownerUid: process.getuid!(), nonce: "C".repeat(43), expiresAt: new Date(Date.now() + 60_000).toISOString() };
}

async function terminal(service: UnsafeFixtureService, token: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const receipt = service.status(token); if (["completed", "failed", "cancelled"].includes(receipt.state)) return receipt;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Unsafe fixture job did not terminate");
}

test.skipIf(process.env.GODOT_MCP_SKIP_PROCESS_FINGERPRINT === "1")("runs arbitrary GDScript in a separate process, stores bounded evidence, and deletes source", async () => {
  const project = await copyFixture();
  let launchError: unknown;
  try {
    const service = new UnsafeFixtureService({
      activation: activation(project.root),
      sessionId: () => "session_12345678",
      launch: async (input) => { try { return await UnsafeFixtureProcess.launch({ ...input, godotBin: "/opt/homebrew/bin/godot" }); } catch (error) { launchError = error; throw error; } },
    });
    const started = await service.execute({ operation: "execute_start", source: 'extends SceneTree\nfunc _init():\n print("PHASE10_UNSAFE_FIXTURE_OK")\n quit()\n', deadlineMs: 5_000 }, "req-1") as { data: { jobToken: string } };
    await terminal(service, started.data.jobToken);
    const result = service.result(started.data.jobToken);
    expect(result, launchError instanceof Error ? launchError.stack : String(launchError)).toMatchObject({ state: "completed", exitCode: 0, unsafe: true, sandboxed: false, cleanup: "succeeded" });
    expect(result.evidence).toHaveLength(1);
    await expect(access(join(project.root, ".godot/evidence/godot-mcp/unsafe", started.data.jobToken))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await project.cleanup(); }
}, 20_000);

it("keeps one opaque session job and cancels only its owned process", async () => {
  const project = await copyFixture(); let release!: (code: number) => void; const waiting = new Promise<number>((resolve) => { release = resolve; });
  let sessionId = "session_12345678";
  const process: UnsafeFixtureProcessHandle & { stopped: number } = { pid: 123, fingerprint: "123:owned", stopped: 0, wait: () => waiting, diagnostics: () => Buffer.from("private output"), outputExceeded: () => false, async stop() { this.stopped += 1; release(143); } };
  try {
    const service = new UnsafeFixtureService({ activation: activation(project.root), sessionId: () => sessionId, launch: async () => process });
    const started = service.start("extends SceneTree", 5_000);
    expect(() => service.start("extends SceneTree", 5_000)).toThrow(/already active/i);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    service.cancel(started.jobToken); await terminal(service, started.jobToken);
    expect(service.result(started.jobToken)).toMatchObject({ state: "cancelled", sandboxed: false });
    expect(process.stopped).toBe(1);
    sessionId = "session_reconnected";
    expect(() => service.status(started.jobToken)).toThrow(/stale/i);
    expect(() => service.status(`ujob_${"D".repeat(43)}`)).toThrow(/stale/i);
  } finally { release(143); await project.cleanup(); }
});

it("cancels an unsafe job while its process is still launching", async () => {
  const project = await copyFixture(); let release!: () => void; const launching = new Promise<void>((resolve) => { release = resolve; }); let stopped = 0;
  try {
    const service = new UnsafeFixtureService({ activation: activation(project.root), sessionId: () => "session_12345678", launch: async () => { await launching; return { pid: 123, fingerprint: "123:owned", wait: async () => 0, stop: async () => { stopped += 1; }, diagnostics: () => Buffer.alloc(0), outputExceeded: () => false }; } });
    const started = service.start("extends SceneTree", 5_000); await new Promise((resolve) => setTimeout(resolve, 10)); service.cancel(started.jobToken); release(); await terminal(service, started.jobToken);
    expect(service.result(started.jobToken)).toMatchObject({ state: "cancelled", cleanup: "succeeded" });
    expect(stopped).toBe(1);
  } finally { release(); await project.cleanup(); }
});

it("chunks bounded output evidence and treats a pre-launch failure as clean", async () => {
  const project = await copyFixture();
  try {
    const large = Buffer.alloc(2 * 1024 * 1024, 65);
    const service = new UnsafeFixtureService({ activation: activation(project.root), sessionId: () => "session_12345678", launch: async () => ({ pid: 123, fingerprint: "123:owned", wait: async () => 0, stop: async () => undefined, diagnostics: () => large, outputExceeded: () => false }) });
    const started = service.start("extends SceneTree", 5_000); await terminal(service, started.jobToken);
    expect(service.result(started.jobToken)).toMatchObject({ state: "completed", cleanup: "succeeded", evidence: expect.arrayContaining([expect.stringMatching(/^godot-mcp:/)]) });
    expect(service.result(started.jobToken).evidence).toHaveLength(4);

    const failing = new UnsafeFixtureService({ activation: activation(project.root), sessionId: () => "session_12345678", launch: async () => { throw new Error("launch failed"); } });
    const failed = failing.start("extends SceneTree", 5_000); await terminal(failing, failed.jobToken);
    expect(failing.result(failed.jobToken)).toMatchObject({ state: "failed", cleanup: "succeeded" });
    expect(failing.blocksExport()).toBe(false);
  } finally { await project.cleanup(); }
});

it("fails activation closed when crash residue exists", async () => {
  const project = await copyFixture();
  try {
    const residue = join(project.root, ".godot/evidence/godot-mcp/unsafe/ujob_residue"); await mkdir(residue, { recursive: true }); await writeFile(join(residue, "script.gd"), "private");
    const service = new UnsafeFixtureService({ activation: activation(project.root), sessionId: () => "session_12345678", launch: async () => { throw new Error("must not launch"); } });
    await expect(service.initialize()).rejects.toThrow(/crash residue/i);
  } finally { await project.cleanup(); }
});
