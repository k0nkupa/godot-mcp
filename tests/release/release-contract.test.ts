import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  buildRelease,
  readCompatibilityMatrix,
  verifyRelease,
} from "../../scripts/release-contract.mjs";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("Phase 11 release contract", () => {
  test("does not advertise pending compatibility cells", async () => {
    const matrix = await readCompatibilityMatrix(resolve("release/compatibility-matrix.json"));
    expect(matrix.cells).toHaveLength(12);
    expect(matrix.cells.filter((cell) => cell.state === "pending").length).toBeGreaterThan(0);
    expect(matrix.cells.filter((cell) => cell.state === "certified").every((cell) => typeof cell.receipt === "string")).toBe(true);
    expect(new Set(matrix.cells.map((cell) => `${cell.godot}/${cell.platform}`)).size).toBe(12);
  });

  test("builds one hash-bound release set and independently verifies it", async () => {
    const output = await mkdtemp(join(tmpdir(), "godot-mcp-release-test-"));
    temporary.push(output);
    const manifest = await buildRelease({ root: resolve("."), output });
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.artifacts.some((artifact) => artifact.name.endsWith(".zip"))).toBe(true);
    expect(manifest.artifacts.filter((artifact) => artifact.name.endsWith(".tgz"))).toHaveLength(5);
    await expect(verifyRelease(output)).resolves.toMatchObject({ version: "0.1.0" });

    const checksums = await readFile(join(output, "SHA256SUMS"), "utf8");
    expect(checksums).not.toContain("release-manifest.json");
    await writeFile(join(output, "unmanifested.txt"), "must not publish\n");
    await expect(verifyRelease(output)).rejects.toThrow(/unmanifested/i);
  }, 30_000);

  test("pins every third-party release workflow action to an immutable commit", async () => {
    for (const workflow of [".github/workflows/compatibility.yml", ".github/workflows/release.yml"]) {
      const contents = await readFile(resolve(workflow), "utf8");
      for (const match of contents.matchAll(/^\s*-?\s*uses:\s*[^@\s]+@([^\s#]+)/gm)) expect(match[1], `${workflow}: ${match[0]}`).toMatch(/^[a-f0-9]{40}$/);
    }
    const release = await readFile(resolve(".github/workflows/release.yml"), "utf8");
    expect(release).toContain("npm install --global npm@12.0.1");
    expect(release).toContain("publish-release.mjs release/out");
    expect(release).toContain('GODOT_ARCHIVE: ${{ runner.temp }}/godot-4.7.zip');
    expect(release).not.toContain("--output godot.zip");
    const publisher = await readFile(resolve("scripts/publish-release.mjs"), "utf8");
    expect(publisher).toContain("Published npm artifact differs from release set");
    expect(publisher).toContain("Existing GitHub asset differs from release set");
    const compatibility = await readFile(resolve(".github/workflows/compatibility.yml"), "utf8");
    expect(compatibility).toContain("write-compatibility-receipt.mjs");
    expect(compatibility).toContain("actions/attest-build-provenance@");
    expect(compatibility).toContain('GODOT_ARCHIVE: ${{ runner.temp }}/godot-4.7.zip');
    expect(compatibility).not.toContain("--output godot.zip");
    expect(await readFile(resolve("scripts/verify-release-preconditions.mjs"), "utf8")).toContain('"attestation", "verify"');
  });
});
