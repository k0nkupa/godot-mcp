import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { copyFixture } from "@godot-mcp/testkit";
import { describe, expect, it } from "vitest";

import { ArtifactStore, scanArtifactDirectory } from "./artifactStore.js";

const jobToken = `pjob_${"A".repeat(43)}`;

describe("project artifact custody", () => {
  it("allocates one contained directory and returns a deterministic path-free manifest", async () => {
    const project = await copyFixture();
    try {
      const store = new ArtifactStore(project.root);
      const allocated = await store.allocate(jobToken, "fixture-release");
      await writeFile(join(allocated.path, "game.pck"), "clean fixture payload");
      await mkdir(join(allocated.path, "Fixture.app"));
      await writeFile(join(allocated.path, "Fixture.app", "binary"), "clean binary");

      const first = await store.finalize(jobToken, "fixture-release");
      const second = await store.finalize(jobToken, "fixture-release");
      expect(second).toEqual(first);
      expect(first).toMatchObject({ name: "fixture-release", entryCount: 2, leakFree: true });
      expect(first.uri).toBe(`godot-mcp://artifact/${jobToken}/${first.sha256}`);
      expect(JSON.stringify(first)).not.toContain(project.root);
    } finally {
      await project.cleanup();
    }
  });

  it("detects leakage split across stream chunks and refuses a releasable manifest", async () => {
    const directory = await mkdtemp("/private/tmp/godot-mcp-artifact-scan-");
    try {
      await writeFile(join(directory, "game.pck"), "prefix-addons/godot_mcp/runtime/runtime_harness.gd-suffix");
      await writeFile(join(directory, "compiled.bin"), "prefix-GodotMcpRuntimeHarness-suffix");
      const scanned = await scanArtifactDirectory(directory, { chunkBytes: 7 });
      expect(scanned.leakFree).toBe(false);
      expect(scanned.findings).toEqual(expect.arrayContaining([expect.objectContaining({ marker: "addons/godot_mcp" })]));
      expect(scanned.findings).toEqual(expect.arrayContaining([expect.objectContaining({ marker: "godotmcpruntimeharness" })]));
    } finally {
      await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true }));
    }
  });

  it("rejects symlinks, occupied allocations, oversized scans, and traversal identities", async () => {
    const project = await copyFixture();
    const outside = await mkdtemp("/private/tmp/godot-mcp-artifact-outside-");
    try {
      const store = new ArtifactStore(project.root);
      const allocated = await store.allocate(jobToken, "safe");
      await expect(store.allocate(jobToken, "safe")).rejects.toMatchObject({ code: "CONFLICT" });
      await symlink(join(outside, "escape"), join(allocated.path, "linked"));
      await expect(store.finalize(jobToken, "safe")).rejects.toMatchObject({ code: "PATH_DENIED" });
      await expect(store.allocate("../escape", "safe")).rejects.toMatchObject({ code: "PATH_DENIED" });

      const large = await mkdtemp("/private/tmp/godot-mcp-artifact-large-");
      try {
        await writeFile(join(large, "large.bin"), Buffer.alloc(33));
        await expect(scanArtifactDirectory(large, { maxBytes: 32 })).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
      } finally {
        await import("node:fs/promises").then(({ rm }) => rm(large, { recursive: true, force: true }));
      }
    } finally {
      await import("node:fs/promises").then(({ rm }) => Promise.all([
        rm(outside, { recursive: true, force: true }),
        project.cleanup(),
      ]));
    }
  });
});
