import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { copyFixture } from "@godot-mcp/testkit";
import { describe, expect, it } from "vitest";

import { ArtifactStore } from "./artifactStore.js";
import { ProjectJobJournal } from "./projectJobJournal.js";
import { ProjectJobService, type ProjectJobProcess } from "./projectJobService.js";

const projectId = "019f75d0-1234-7abc-8def-0123456789ab";

function fakeProcess(exitCode = 0, waitOverride?: Promise<number>): ProjectJobProcess & { stopped: number } {
  return {
    pid: 123,
    fingerprint: "123:owned",
    stopped: 0,
    diagnostics: () => "bounded project output",
    wait: () => waitOverride ?? Promise.resolve(exitCode),
    async stop() { this.stopped += 1; },
  };
}

async function terminal(service: ProjectJobService, token: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = service.status(token);
    if (["completed", "failed", "cancelled"].includes(status.state)) return status;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Project job did not terminate");
}

describe("ProjectJobService", () => {
  it("runs one export, scans its owned artifact, persists output evidence, and returns a manifest", async () => {
    const project = await copyFixture();
    const calls: unknown[] = [];
    try {
      const artifacts = new ArtifactStore(project.root);
      const service = new ProjectJobService({
        projectId,
        projectRoot: project.root,
        sessionId: () => "session_12345678",
        artifacts,
        launch: async (input) => {
          calls.push(input);
          if (input.operation !== "export") throw new Error("Expected export process");
          await writeFile(input.outputPath, "clean exported fixture");
          return fakeProcess();
        },
      });
      const started = service.start({ operation: "export_start", preset: "macOS", mode: "release", artifactName: "fixture", deadlineMs: 5_000 });
      await terminal(service, started.jobToken);
      const result = service.result(started.jobToken);
      expect(result).toMatchObject({ state: "completed", operation: "export", exitCode: 0, artifact: { name: "fixture", leakFree: true } });
      expect(result.evidence[0]).toMatch(/^godot-mcp:\/\/evidence\//);
      expect(calls).toEqual([expect.objectContaining({ operation: "export", mode: "release", preset: "macOS" })]);
    } finally {
      await project.cleanup();
    }
  });

  it("rejects concurrent and stale jobs and never launches an immediately cancelled queued job", async () => {
    const project = await copyFixture();
    const calls: unknown[] = [];
    try {
      const service = new ProjectJobService({
        projectId,
        projectRoot: project.root,
        sessionId: () => "session_12345678",
        artifacts: new ArtifactStore(project.root),
        launch: async (input) => { calls.push(input); return fakeProcess(); },
      });
      const started = service.start({ operation: "run_start", headless: true, deadlineMs: 5_000 });
      expect(() => service.start({ operation: "build_start", kind: "solutions", deadlineMs: 5_000 })).toThrow(/active/i);
      service.cancel(started.jobToken);
      await terminal(service, started.jobToken);
      expect(service.result(started.jobToken)).toMatchObject({ state: "cancelled", exitCode: null });
      expect(calls).toEqual([]);
      expect(() => service.status(`pjob_${"B".repeat(43)}`)).toThrowError(expect.objectContaining({ code: "STALE_HANDLE" }));
    } finally {
      await project.cleanup();
    }
  });

  it("refuses export before allocation while another owned subsystem conflicts", async () => {
    const project = await copyFixture();
    try {
      const service = new ProjectJobService({
        projectId,
        projectRoot: project.root,
        sessionId: () => "session_12345678",
        artifacts: new ArtifactStore(project.root),
        launch: async () => fakeProcess(),
        conflictReason: (input) => input.operation === "export_start" ? "Owned runtime is active" : null,
      });
      expect(() => service.start({ operation: "export_start", preset: "Safe", mode: "release", artifactName: "fixture", deadlineMs: 5_000 })).toThrow(/runtime is active/i);
    } finally { await project.cleanup(); }
  });

  it("stops only its owned process on cancellation and reports nonzero exits as failed", async () => {
    const project = await copyFixture();
    let release!: (code: number) => void;
    const waiting = new Promise<number>((resolve) => { release = resolve; });
    const process = fakeProcess(0, waiting);
    try {
      const service = new ProjectJobService({
        projectId,
        projectRoot: project.root,
        sessionId: () => "session_12345678",
        artifacts: new ArtifactStore(project.root),
        launch: async () => process,
      });
      const started = service.start({ operation: "import_start", kind: "full", deadlineMs: 5_000 });
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      service.cancel(started.jobToken);
      release(143);
      await terminal(service, started.jobToken);
      expect(service.result(started.jobToken)).toMatchObject({ state: "cancelled" });
      expect(process.stopped).toBe(1);

      const failedService = new ProjectJobService({
        projectId,
        projectRoot: project.root,
        sessionId: () => "session_12345678",
        artifacts: new ArtifactStore(project.root),
        launch: async () => fakeProcess(2),
      });
      const failed = failedService.start({ operation: "build_start", kind: "solutions", deadlineMs: 5_000 });
      await terminal(failedService, failed.jobToken);
      expect(failedService.result(failed.jobToken)).toMatchObject({ state: "failed", exitCode: 2 });
    } finally {
      release(143);
      await project.cleanup();
    }
  });

  it("keeps selective reimport running while cancellation is unsafe, then reports the pending cancellation", async () => {
    const project = await copyFixture();
    let release!: () => void;
    const importing = new Promise<void>((resolve) => { release = resolve; });
    try {
      const service = new ProjectJobService({
        projectId,
        projectRoot: project.root,
        sessionId: () => "session_12345678",
        artifacts: new ArtifactStore(project.root),
        launch: async () => { throw new Error("Selective reimport must not launch a child"); },
        reimport: async () => importing,
      });
      const started = service.start({ operation: "import_start", kind: "reimport", resourcePaths: ["res://icon.svg"], deadlineMs: 5_000 });
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(service.status(started.jobToken)).toMatchObject({ state: "running", cancellationSafe: false });
      service.cancel(started.jobToken);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(service.status(started.jobToken)).toMatchObject({ state: "running", cancellationSafe: false });
      expect(() => service.result(started.jobToken)).toThrow(/not terminal/i);
      release();
      await terminal(service, started.jobToken);
      expect(service.result(started.jobToken)).toMatchObject({ state: "cancelled" });
    } finally {
      release();
      await project.cleanup();
    }
  });

  it("does not close its bridge lifecycle while a non-interruptible reimport is still executing", async () => {
    const project = await copyFixture();
    let release!: () => void;
    const importing = new Promise<void>((resolve) => { release = resolve; });
    try {
      const service = new ProjectJobService({
        projectId,
        projectRoot: project.root,
        sessionId: () => "session_12345678",
        artifacts: new ArtifactStore(project.root),
        launch: async () => { throw new Error("Unexpected process launch"); },
        reimport: async () => importing,
      });
      service.start({ operation: "import_start", kind: "reimport", resourcePaths: ["res://icon.svg"], deadlineMs: 5_000 });
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      let closed = false;
      const closing = service.close().then(() => { closed = true; });
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(closed).toBe(false);
      release();
      await closing;
      expect(closed).toBe(true);
    } finally {
      release();
      await project.cleanup();
    }
  });

  it("recovers an exact journaled process identity and scans partial export residue", async () => {
    const project = await copyFixture();
    const token = `pjob_${"C".repeat(43)}`;
    try {
      const artifacts = new ArtifactStore(project.root);
      const allocated = await artifacts.allocate(token, "recovered");
      await writeFile(join(allocated.path, "leaked.pck"), "GodotMcpRuntimeHarness");
      const path = join(project.root, ".godot/evidence/godot-mcp/project-jobs.jsonl");
      const journal = await ProjectJobJournal.open(path);
      await journal.append({ projectId, jobToken: token, sessionId: "session_12345678", operation: "export", state: "running", pid: 456, fingerprint: "456:owned", artifactName: "recovered" });
      const recovered: unknown[] = [];
      const service = new ProjectJobService({
        projectId,
        projectRoot: project.root,
        sessionId: () => null,
        artifacts,
        journal,
        recoverProcess: async (pid, fingerprint) => { recovered.push({ pid, fingerprint }); return "stopped"; },
        launch: async () => { throw new Error("Recovery must not launch"); },
      });
      await service.recover();
      expect(recovered).toEqual([{ pid: 456, fingerprint: "456:owned" }]);
      expect(journal.nonterminal(projectId)).toEqual([]);
      expect(await import("node:fs/promises").then(({ readFile }) => readFile(path, "utf8"))).toContain('"artifactRecovery":"rejected"');
    } finally { await project.cleanup(); }
  });
});
