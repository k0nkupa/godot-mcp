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
  process.stdout.write(`\n[phase-8] ${label}\n`);
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

async function runGodotUnit(label, godot, project, script, marker, environment) {
  const logFile = join(resolve(environment.XDG_RUNTIME_DIR), `${marker}.log`);
  process.stdout.write(`\n[phase-8] ${label}\n`);
  const output = await new Promise((resolvePromise, reject) => {
    const child = spawn(godot, [
      "--headless", "--rendering-method", "gl_compatibility", "--rendering-driver", "opengl3",
      "--log-file", logFile, "--path", project, "--script", script,
    ], { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { text += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { text += chunk; process.stderr.write(chunk); });
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolvePromise(text) : reject(new Error(`${label} failed (${code ?? signal ?? "unknown"})`)));
  });
  const logged = await import("node:fs/promises").then(({ readFile }) => readFile(logFile, "utf8").catch(() => ""));
  const combined = `${output}\n${logged}`;
  if (!combined.includes(marker) || /SCRIPT ERROR:|Failed to load script|Parse Error:/.test(combined)) {
    throw new Error(`${label} did not produce a clean ${marker} receipt`);
  }
}

async function withFixture(prefix, callback) {
  const container = await mkdtemp(join(tmpdir(), prefix));
  const project = join(container, "project");
  const environment = { ...gateEnvironment, XDG_RUNTIME_DIR: join(container, "runtime") };
  try {
    await cp(join(root, "fixtures/godot-4.7"), project, { recursive: true });
    await mkdir(environment.XDG_RUNTIME_DIR, { recursive: true });
    await callback({ project, environment });
  } finally {
    await rm(container, { force: true, recursive: true });
  }
}

if (process.platform !== "darwin") throw new Error("Phase 8 certification requires macOS");
await mkdir(artifactParent, { recursive: true });
const failureArtifacts = await mkdtemp(join(artifactParent, "godot-mcp-phase-8-"));
const cleanupRecord = join(failureArtifacts, "phase-8-cleanup-record.json");
gateEnvironment = { ...process.env, GODOT_MCP_FAILURE_ARTIFACT_DIR: failureArtifacts, GODOT_MCP_PHASE8_CLEANUP_RECORD: cleanupRecord };
const godot = await godotBinary();
const version = await readOutput(godot, ["--version"]);
if (version !== "4.7.stable.official.5b4e0cb0f") throw new Error(`Godot 4.7.stable.official.5b4e0cb0f is required; detected ${version || "unknown"}`);
process.stdout.write(`[phase-8] 1/16 Godot version ${version}\n`);

let passed = false;
try {
  await run("2/16 generated protocol drift", process.execPath, ["scripts/generate-godot-protocol.mjs", "--check"]);
  await run("3/16 topological package builds", pnpm, ["build"]);
  await run("4/16 ESLint", pnpm, ["lint"]);
  await run("5/16 TypeScript typecheck", pnpm, ["typecheck"]);
  await run("6/16 focused visual units", pnpm, ["exec", "vitest", "run",
    "packages/protocol/src/visual.test.ts", "packages/protocol/src/schemas.test.ts",
    "packages/control-plane/src/evidence/evidenceStore.test.ts", "packages/control-plane/src/visual",
    "packages/control-plane/src/runtime/runtimeDescriptor.test.ts", "packages/control-plane/src/runtime/runtimeProcess.test.ts", "packages/control-plane/src/runtime/runtimeService.test.ts",
    "packages/mcp-server/src/registerVisualTools.test.ts", "packages/mcp-server/src/createServer.test.ts",
    "packages/testkit/src/visual.test.ts"]);
  await withFixture("godot-mcp-phase-8-import-", async ({ project, environment }) => {
    await run("7/16 disposable fixture import", godot, ["--headless", "--editor", "--log-file", join(environment.XDG_RUNTIME_DIR, "import.log"), "--path", project, "--import"], environment);
  });
  await withFixture("godot-mcp-phase-8-units-", async ({ project, environment }) => {
    await mkdir(join(project, "addons"), { recursive: true });
    await cp(join(root, "addons/godot_mcp"), join(project, "addons/godot_mcp"), { recursive: true });
    await runGodotUnit("8/16 visual fixture unit", godot, project, "res://tests/visual_fixture_unit.gd", "PHASE8_VISUAL_FIXTURE_OK", environment);
    await runGodotUnit("8/16 pinned runtime harness unit", godot, project, "res://tests/runtime_harness_unit.gd", "GODOT_MCP_RUNTIME_HARNESS_UNIT_OK", environment);
  });
  await run("9/16 authenticated visual integration", pnpm, ["exec", "vitest", "run", "tests/integration/visual-scenario.test.ts", "--fileParallelism=false"]);
  await run("10/16 hostile visual matrix", pnpm, ["exec", "vitest", "run", "tests/security/visual-hostile.test.ts", "--fileParallelism=false"]);
  await run("11/16 published stdio Phase 8 E2E", pnpm, ["exec", "vitest", "run", "tests/end-to-end/phase-8.test.ts", "--fileParallelism=false"]);
  await run("12/16 isolated town-building-game acceptance", pnpm, ["exec", "vitest", "run", "tests/acceptance/town-building-game-phase-8.test.ts", "--fileParallelism=false"]);
  await run("13/16 serialized full regression suite", pnpm, ["exec", "vitest", "run", "--fileParallelism=false"]);
  await run("14/16 cleanup verification", process.execPath, ["scripts/verify-phase-8-cleanup.mjs", cleanupRecord]);
  await run("15/16 committed branch diff check", "git", ["diff", "--check", `${process.env.GODOT_MCP_DIFF_BASE ?? "main"}...HEAD`]);
  await run("16/16 working-tree diff check", "git", ["diff", "--check"]);
  const workingTreeStatus = await readOutput("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (workingTreeStatus) throw new Error(`16/16 working-tree cleanliness failed:\n${workingTreeStatus}`);
  passed = true;
  process.stdout.write("\n[phase-8] PASS (16/16 stages)\n");
} finally {
  if (passed) await rm(failureArtifacts, { force: true, recursive: true });
}
