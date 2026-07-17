import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const fixture = resolve(root, "fixtures/godot-4.7");
const artifactPattern = /\.godot-mcp-.*\.(?:tmp|bak)(?:\.|$)/;
const offenders = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const name = relative(fixture, path);
    if (entry.isDirectory()) {
      if (name.includes(".godot/godot-mcp/mutation-journal")) offenders.push(name);
      else await visit(path);
    } else if (artifactPattern.test(entry.name)) offenders.push(name);
  }
}

await visit(fixture);
const fixtureStatus = spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "--", "fixtures/godot-4.7"], { cwd: root, encoding: "utf8" });
if (fixtureStatus.status !== 0) throw new Error(fixtureStatus.stderr || "Could not inspect fixture status");
if (fixtureStatus.stdout.trim()) offenders.push(...fixtureStatus.stdout.trim().split("\n"));
if (offenders.length > 0) {
  process.stderr.write(`Phase 6 cleanup verification failed:\n${offenders.sort().join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("Phase 6 fixture and transaction cleanup verified\n");
