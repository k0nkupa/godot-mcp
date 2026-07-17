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
  process.stdout.write(`\n[phase-6] ${label}\n`);
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

if (process.platform !== "darwin") throw new Error("Phase 6 certification requires macOS with a WindowServer session");
await mkdir(artifactParent, { recursive: true });
const failureArtifacts = await mkdtemp(join(artifactParent, "godot-mcp-phase-6-"));
gateEnvironment = { ...process.env, GODOT_MCP_FAILURE_ARTIFACT_DIR: failureArtifacts };
const godot = await godotBinary();
const version = await readOutput(godot, ["--version"]);
if (version !== "4.7.stable.official.5b4e0cb0f") throw new Error(`Godot 4.7.stable.official.5b4e0cb0f is required; detected ${version || "unknown"}`);
process.stdout.write(`[phase-6] 1/15 Godot version ${version}\n`);

let passed = false;
try {
  await run("2/15 topological package builds", pnpm, ["build"]);
  await run("3/15 ESLint", pnpm, ["lint"]);
  await run("4/15 TypeScript typecheck", pnpm, ["typecheck"]);
  await run("5/15 Phase 6 contracts and service tests", pnpm, ["exec", "vitest", "run", "packages/protocol/src/editorAuthoring.test.ts", "packages/protocol/src/editorMutation.test.ts", "packages/control-plane/src/editor", "packages/mcp-server/src/registerEditorTools.test.ts"]);
  await withFixture("godot-mcp-phase-6-import-", async ({ project, environment }) => {
    await run("6/15 disposable fixture import", godot, ["--headless", "--editor", "--path", project, "--import"], environment);
  });
  await withFixture("godot-mcp-phase-6-units-", async ({ project, environment }) => {
    await run("7/15 authoring unit setup", process.execPath, ["packages/cli/dist/bin.js", "init", "--project", project], environment);
    for (const unit of ["authoring_resource_unit.gd", "authoring_source_unit.gd", "authoring_domains_unit.gd", "editor_authoring_transaction_unit.gd"]) {
      await run("7/15 GDScript authoring units", godot, ["--headless", "--path", project, "--script", `res://tests/${unit}`], environment);
    }
  });
  await run("8/15 authenticated editor authoring integration", pnpm, ["exec", "vitest", "run", "tests/integration/editor-authoring.test.ts"]);
  await run("9/15 hostile authoring matrix", pnpm, ["exec", "vitest", "run", "tests/security/editor-authoring-hostile.test.ts"]);
  await run("10/15 published stdio Phase 6 E2E", pnpm, ["exec", "vitest", "run", "tests/end-to-end/phase-6.test.ts"]);
  await run("11/15 serialized full regression suite", pnpm, ["exec", "vitest", "run", "--fileParallelism=false"]);
  await run("12/15 generated protocol drift", process.execPath, ["scripts/generate-godot-protocol.mjs", "--check"]);
  await run("13/15 fixture and transaction cleanup", process.execPath, ["scripts/verify-phase-6-cleanup.mjs"]);
  await run("14/15 committed branch diff check", "git", ["diff", "--check", `${process.env.GODOT_MCP_DIFF_BASE ?? "main"}...HEAD`]);
  await run("15/15 working tree diff check", "git", ["diff", "--check"]);
  passed = true;
  process.stdout.write("\n[phase-6] PASS (15/15 stages)\n");
} finally {
  if (passed) await rm(failureArtifacts, { force: true, recursive: true });
}
