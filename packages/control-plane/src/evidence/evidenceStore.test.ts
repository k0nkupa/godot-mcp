import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { copyFixture } from "@godot-mcp/testkit";
import { describe, expect, it } from "vitest";

import { EvidenceStore } from "./evidenceStore.js";

const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("EvidenceStore", () => {
  it("writes content-addressed owner-only PNG evidence idempotently", async () => {
    const project = await copyFixture();
    try {
      await chmod(project.root, 0o700);
      const store = new EvidenceStore(project.root);
      const first = await store.putPng("session_12345678", png, {
        viewport: "2d",
        width: 1,
        height: 1,
      });
      const second = await store.putPng("session_12345678", png, {
        viewport: "2d",
        width: 1,
        height: 1,
      });
      expect(second).toMatchObject({ uri: first.uri, sha256: first.sha256, path: first.path });
      expect(second.observationUri).not.toBe(first.observationUri);
      expect(first.uri).toBe(`godot-mcp://evidence/${first.sha256}`);
      expect(first.observationUri).toMatch(new RegExp(`^godot-mcp://evidence/${first.sha256}/observations/`));
      expect(await readFile(first.path)).toEqual(png);
      expect(JSON.parse(await readFile(first.observationPath, "utf8"))).toMatchObject({ viewport: "2d", width: 1, height: 1 });
      expect((await stat(first.path)).mode & 0o077).toBe(0);
      expect((await stat(first.observationPath)).mode & 0o077).toBe(0);
    } finally {
      await project.cleanup();
    }
  });

  it("rejects invalid sessions, non-PNG bytes, and oversized evidence", async () => {
    const project = await copyFixture();
    try {
      const store = new EvidenceStore(project.root);
      await expect(
        store.putPng("../escape", png, { viewport: "2d", width: 1, height: 1 }),
      ).rejects.toMatchObject({ code: "PATH_DENIED" });
      await expect(
        store.putPng("session_12345678", Buffer.from("not-png"), {
          viewport: "2d",
          width: 1,
          height: 1,
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(
        store.putPng("session_12345678", Buffer.alloc(8 * 1024 * 1024 + 1), {
          viewport: "2d",
          width: 1,
          height: 1,
        }),
      ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    } finally {
      await project.cleanup();
    }
  });

  it("reads only verified PNG observations owned by the current session", async () => {
    const project = await copyFixture();
    try {
      const store = new EvidenceStore(project.root);
      const stored = await store.putPng("session_12345678", png, { viewport: "runtime", width: 1, height: 1 });

      await expect(store.readSessionPngObservation("session_12345678", stored.observationUri)).resolves.toMatchObject({
        data: png,
        sha256: stored.sha256,
        width: 1,
        height: 1,
      });
      await expect(store.readSessionPngObservation("session_other123", stored.observationUri)).rejects.toMatchObject({ code: "STALE_HANDLE" });
      await expect(store.readSessionPngObservation("session_12345678", "file:///tmp/a.png")).rejects.toMatchObject({ code: "PATH_DENIED" });

      await writeFile(stored.path, Buffer.concat([png, Buffer.from("changed")]));
      await expect(store.readSessionPngObservation("session_12345678", stored.observationUri)).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      await project.cleanup();
    }
  });

  it("writes bounded canonical owner-only JSON evidence", async () => {
    const project = await copyFixture();
    try {
      const store = new EvidenceStore(project.root);
      const stored = await store.putJson("session_12345678", { z: 1, a: [true, null] }, { kind: "scenario_report" });

      expect(await readFile(stored.path, "utf8")).toBe('{"a":[true,null],"z":1}');
      expect(stored.mimeType).toBe("application/json");
      expect(stored.observationUri).toMatch(/^godot-mcp:\/\/evidence\/[a-f0-9]{64}\/observations\//);
      expect((await stat(stored.path)).mode & 0o077).toBe(0);
      expect((await stat(stored.observationPath)).mode & 0o077).toBe(0);

      const protectedIdentity = await store.putJson("session_12345678", { safe: true }, {
        observationId: "attacker",
        sha256: "0".repeat(64),
        mimeType: "text/plain",
        byteLength: 1,
      });
      expect(JSON.parse(await readFile(protectedIdentity.observationPath, "utf8"))).toMatchObject({
        observationId: protectedIdentity.observationUri.split("/").at(-1),
        sha256: protectedIdentity.sha256,
        mimeType: "application/json",
        byteLength: protectedIdentity.byteLength,
      });

      await expect(store.putJson("session_12345678", { payload: "x".repeat(1024 * 1024) }, { kind: "scenario_report" }))
        .rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    } finally {
      await project.cleanup();
    }
  });

  it("creates immutable named PNG baselines without exposing host paths", async () => {
    const project = await copyFixture();
    try {
      const store = new EvidenceStore(project.root);
      const first = await store.putPng("session_12345678", png, { viewport: "runtime", width: 1, height: 1 });
      const created = await store.createPngBaseline("session_12345678", "fixture-ready", first.observationUri, 1234);
      const repeated = await store.createPngBaseline("session_12345678", "fixture-ready", first.observationUri, 9999);

      expect(repeated).toEqual(created);
      expect(created).toMatchObject({
        schemaVersion: 1,
        comparisonContractVersion: 1,
        name: "fixture-ready",
        sha256: first.sha256,
        width: 1,
        height: 1,
        sourceObservationSha256: first.sha256,
        createdAtUnixMs: 1234,
      });
      expect(created).not.toHaveProperty("path");
      await expect(store.readPngBaseline("fixture-ready")).resolves.toEqual(created);

      const different = await store.putPng("session_12345678", Buffer.concat([png, Buffer.from("different")]), {
        viewport: "runtime",
        width: 1,
        height: 1,
      });
      await expect(store.createPngBaseline("session_12345678", "fixture-ready", different.observationUri))
        .rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      await project.cleanup();
    }
  });

  it("rejects symlinked baseline bytes", async () => {
    const project = await copyFixture();
    try {
      const store = new EvidenceStore(project.root);
      const stored = await store.putPng("session_12345678", png, { viewport: "runtime", width: 1, height: 1 });
      const baseline = await store.createPngBaseline("session_12345678", "linked", stored.observationUri);
      const baselinePath = join(project.root, ".godot/evidence/godot-mcp/baselines/linked", `${baseline.sha256}.png`);
      await rm(baselinePath);
      await symlink(stored.path, baselinePath);

      await expect(store.readPngBaseline("linked")).rejects.toMatchObject({ code: "PATH_DENIED" });
    } finally {
      await project.cleanup();
    }
  });

  it("rejects a symlinked existing baseline manifest during creation", async () => {
    const project = await copyFixture();
    try {
      const store = new EvidenceStore(project.root);
      const stored = await store.putPng("session_12345678", png, { viewport: "runtime", width: 1, height: 1 });
      await store.createPngBaseline("session_12345678", "linked-manifest", stored.observationUri);
      const manifestPath = join(project.root, ".godot/evidence/godot-mcp/baselines/linked-manifest/manifest.json");
      await rm(manifestPath);
      await symlink(stored.observationPath, manifestPath);

      await expect(store.createPngBaseline("session_12345678", "linked-manifest", stored.observationUri))
        .rejects.toMatchObject({ code: "PATH_DENIED" });
    } finally {
      await project.cleanup();
    }
  });

  it("rejects symlinked session and baseline directories before writing", async () => {
    const project = await copyFixture();
    const outside = await mkdtemp("/private/tmp/godot-mcp-evidence-escape-");
    try {
      const store = new EvidenceStore(project.root);
      const sessions = join(project.root, ".godot/evidence/godot-mcp/sessions");
      await mkdir(sessions, { recursive: true });
      await symlink(outside, join(sessions, "session_12345678"));
      await expect(store.putPng("session_12345678", png, { viewport: "runtime", width: 1, height: 1 }))
        .rejects.toMatchObject({ code: "PATH_DENIED" });
      expect(await access(join(outside, `${"0".repeat(64)}.png`)).then(() => true, () => false)).toBe(false);

      await rm(join(sessions, "session_12345678"));
      const stored = await store.putPng("session_12345678", png, { viewport: "runtime", width: 1, height: 1 });
      const baselines = join(project.root, ".godot/evidence/godot-mcp/baselines");
      await mkdir(baselines, { recursive: true });
      await symlink(outside, join(baselines, "redirected"));
      await expect(store.createPngBaseline("session_12345678", "redirected", stored.observationUri))
        .rejects.toMatchObject({ code: "PATH_DENIED" });
      expect(await access(join(outside, "manifest.json")).then(() => true, () => false)).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
      await project.cleanup();
    }
  });
});
