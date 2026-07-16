import { chmod, readFile, stat } from "node:fs/promises";

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
});
