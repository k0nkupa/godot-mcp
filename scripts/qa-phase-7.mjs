import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const artifactParent = process.env.GODOT_MCP_FAILURE_ARTIFACT_DIR ?? tmpdir();
let gateEnvironment = { ...process.env };

async function executable(path) {
  try { await access(path, constants.X_OK); return true; } catch { return false; }
}

async function godotBinary() {
  for (const candidate of [process.env.GODOT_BIN, "/opt/homebrew/bin/godot", "/usr/local/bin/godot"]) {
    if (candidate && await executable(candidate)) return candidate;
  }
  throw new Error("Godot 4.7 executable not found; set GODOT_BIN");
}

async function run(label, command, args, environment = gateEnvironment) {
  process.stdout.write(`\n[phase-7] ${label}\n`);
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, env: environment, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0
      ? resolvePromise()
      : reject(new Error(`${label} failed (${code ?? signal ?? "unknown"})`)));
  });
}

async function readOutput(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, env: gateEnvironment, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolvePromise(output.trim()) : reject(new Error(output)));
  });
}

async function withFixture(prefix, callback) {
  const container = await mkdtemp(join(tmpdir(), prefix));
  const project = join(container, "project");
  const environment = { ...gateEnvironment, XDG_RUNTIME_DIR: join(container, "runtime") };
  try {
    await cp(join(root, "fixtures/godot-4.7"), project, { recursive: true });
    await callback({ project, environment });
  } finally {
    await rm(container, { force: true, recursive: true });
  }
}

if (process.platform !== "darwin") throw new Error("Phase 7 certification requires macOS");
await mkdir(artifactParent, { recursive: true });
const failureArtifacts = await mkdtemp(join(artifactParent, "godot-mcp-phase-7-"));
const cleanupRecord = join(failureArtifacts, "phase-7-cleanup-record.json");
gateEnvironment = {
  ...process.env,
  GODOT_MCP_FAILURE_ARTIFACT_DIR: failureArtifacts,
  GODOT_MCP_PHASE7_CLEANUP_RECORD: cleanupRecord,
};
const godot = await godotBinary();
const version = await readOutput(godot, ["--version"]);
if (version !== "4.7.stable.official.5b4e0cb0f") throw new Error(`Godot 4.7.stable.official.5b4e0cb0f is required; detected ${version || "unknown"}`);
process.stdout.write(`[phase-7] 1/16 Godot version ${version}\n`);

let passed = false;
try {
  await run("2/16 generated protocol drift", process.execPath, ["scripts/generate-godot-protocol.mjs", "--check"]);
  await run("3/16 topological package builds", pnpm, ["build"]);
  await run("4/16 ESLint", pnpm, ["lint"]);
  await run("5/16 TypeScript typecheck", pnpm, ["typecheck"]);
  await run("6/16 Phase 7 protocol, authenticated debugger, runtime, and MCP tests", pnpm, ["exec", "vitest", "run",
    "packages/protocol/src/runtimeDebug.test.ts", "packages/protocol/src/runtimePerformance.test.ts",
    "packages/control-plane/src/runtime/debugTokenStore.test.ts",
    "packages/control-plane/src/runtime/runtimeDebugService.test.ts",
    "packages/control-plane/src/runtime/runtimePerformanceService.test.ts", "packages/control-plane/src/runtime/runtimeService.test.ts",
    "packages/mcp-server/src/registerRuntimeTools.test.ts", "packages/mcp-server/src/executeTool.test.ts"]);
  await withFixture("godot-mcp-phase-7-import-", async ({ project, environment }) => {
    await run("7/16 disposable fixture import", godot, ["--headless", "--editor", "--path", project, "--import"], environment);
  });
  await withFixture("godot-mcp-phase-7-units-", async ({ project, environment }) => {
    await run("8/16 GDScript unit setup", process.execPath, ["packages/cli/dist/bin.js", "init", "--project", project], environment);
    for (const unit of ["runtime_profiler_unit.gd", "runtime_harness_unit.gd"]) {
      await run("8/16 runtime profiler and harness units", godot, ["--headless", "--path", project, "--script", `res://tests/${unit}`], environment);
    }
  });
  await run("9/16 real debugger and performance integrations", pnpm, ["exec", "vitest", "run",
    "tests/integration/runtime-debugging.test.ts", "tests/integration/runtime-performance.test.ts", "--fileParallelism=false"]);
  await run("10/16 hostile Phase 7 matrix", pnpm, ["exec", "vitest", "run", "tests/security/runtime-debugging-hostile.test.ts", "--fileParallelism=false"]);
  await run("11/16 published stdio Phase 7 E2E", pnpm, ["exec", "vitest", "run", "tests/end-to-end/phase-7.test.ts", "--fileParallelism=false"]);
  await run("12/16 serialized full regression suite", pnpm, ["exec", "vitest", "run", "--fileParallelism=false"]);
  await run("13/16 runtime and fixture cleanup", process.execPath, ["scripts/verify-phase-7-cleanup.mjs", cleanupRecord]);
  await run("14/16 committed branch diff check", "git", ["diff", "--check", `${process.env.GODOT_MCP_DIFF_BASE ?? "main"}...HEAD`]);
  await run("15/16 committed fixture diff check", "git", ["diff", "--exit-code", "HEAD", "--", "fixtures/godot-4.7"]);
  process.stdout.write("\n[phase-7] 16/16 working tree status check\n");
  const workingTreeStatus = await readOutput("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (workingTreeStatus) throw new Error(`16/16 working tree status check failed:\n${workingTreeStatus}`);
  passed = true;
  process.stdout.write("\n[phase-7] PASS (16/16 stages)\n");
} finally {
  if (passed) await rm(failureArtifacts, { force: true, recursive: true });
}
