import { spawnSync } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const fixture = resolve(root, "fixtures/godot-4.7");
const recordPath = process.argv[2] ?? process.env.GODOT_MCP_PHASE7_CLEANUP_RECORD;
const residuePattern = /(?:^|\/)(?:\.consuming-)?runtime-[^/]+\.(?:json|lease)$|godot-mcp-phase7|phase-7-profile|profile-evidence/i;
const offenders = [];

async function exists(path) {
  return access(path).then(() => true, () => false);
}

async function visit(directory, labelRoot = directory) {
  if (!(await exists(directory))) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const label = relative(labelRoot, path);
    if (entry.isDirectory()) await visit(path, labelRoot);
    else if (residuePattern.test(label)) offenders.push(`${labelRoot}: ${label}`);
  }
}

await visit(fixture, fixture);
const fixtureStatus = spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "--", "fixtures/godot-4.7"], { cwd: root, encoding: "utf8" });
if (fixtureStatus.status !== 0) throw new Error(fixtureStatus.stderr || "Could not inspect fixture status");
if (fixtureStatus.stdout.trim()) offenders.push(...fixtureStatus.stdout.trim().split("\n").map((line) => `fixture diff: ${line}`));

if (recordPath && await exists(recordPath)) {
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  if (typeof record.projectRoot === "string") await visit(record.projectRoot, record.projectRoot);
  if (typeof record.runtimeDirectory === "string") await visit(record.runtimeDirectory, record.runtimeDirectory);
  for (const pid of Array.isArray(record.pids) ? record.pids : []) {
    if (!Number.isInteger(pid) || pid < 1) {
      offenders.push(`invalid recorded PID: ${String(pid)}`);
      continue;
    }
    try {
      process.kill(pid, 0);
      offenders.push(`live recorded PID: ${pid}`);
    } catch {}
  }
  for (const port of Array.isArray(record.ports) ? record.ports : []) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      offenders.push(`invalid recorded port: ${String(port)}`);
      continue;
    }
    const checked = spawnSync(process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof", [
      "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn",
    ], { encoding: "utf8" });
    if (checked.stdout.trim()) offenders.push(`listener remains on recorded port ${port}: ${checked.stdout.trim().replaceAll("\n", " ")}`);
  }
}

if (offenders.length > 0) {
  process.stderr.write(`Phase 7 cleanup verification failed:\n${offenders.sort().join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("Phase 7 fixture, runtime, DAP, descriptor, lease, and profile cleanup verified\n");
