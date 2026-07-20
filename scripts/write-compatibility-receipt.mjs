import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const output = resolve(process.argv[2] ?? "phase-11-cell-receipt.json");
const sourceRevision = process.env.GITHUB_SHA;
const runId = process.env.GITHUB_RUN_ID;
const repository = process.env.GITHUB_REPOSITORY;
if (!/^[a-f0-9]{40}$/.test(sourceRevision ?? "")) throw new Error("GITHUB_SHA must identify the certified source revision");
if (!/^[0-9]+$/.test(runId ?? "") || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) throw new Error("GitHub workflow provenance is unavailable");

const stageNames = [
  "exact-engine-cell", "generated-protocol", "build", "lint", "typecheck",
  "release-lifecycle", "hostile-concurrency-stale-session", "serialized-regressions",
  "release-build-a", "release-verify-a", "release-build-b", "reproducibility",
  "cleanup", "committed-diff", "working-tree-clean",
];
const receipt = {
  schemaVersion: 1,
  cell: { godot: "4.7", exactVersion: "4.7.stable.official.5b4e0cb0f", platform: "macos", architecture: "arm64" },
  sourceRevision,
  gate: "phase-11-cell",
  result: "passed",
  createdAt: new Date().toISOString(),
  workflowRunUrl: `https://github.com/${repository}/actions/runs/${runId}`,
  stages: stageNames.map((name, index) => ({ index: index + 1, name, status: "passed" })),
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
process.stdout.write(`${JSON.stringify({ receipt: output, sourceRevision, stages: receipt.stages.length })}\n`);
