import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "vitest";

test("Phase 8 cleanup verification rejects a missing required record", async () => {
  const directory = await mkdtemp("/private/tmp/godot-mcp-phase8-verifier-");
  try {
    const missingRecord = join(directory, "missing.json");
    const result = spawnSync(process.execPath, ["scripts/verify-phase-8-cleanup.mjs", missingRecord], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("required cleanup record is missing");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
