import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const failureArtifacts = process.env.GODOT_MCP_FAILURE_ARTIFACT_DIR
  ?? join(tmpdir(), "godot-mcp-phase-3-failure-artifacts");
const gateEnvironment = { ...process.env, GODOT_MCP_FAILURE_ARTIFACT_DIR: failureArtifacts };

async function executable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function godotBinary() {
  for (const candidate of [process.env.GODOT_BIN, "/opt/homebrew/bin/godot", "/usr/local/bin/godot"]) {
    if (candidate && await executable(candidate)) return candidate;
  }
  throw new Error("Godot 4.7 executable not found; set GODOT_BIN");
}

async function run(label, command, args, environment = gateEnvironment) {
  process.stdout.write(`\n[phase-3] ${label}\n`);
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, env: environment, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${label} failed (${code ?? signal ?? "unknown"})`));
    });
  });
}

async function readOutput(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, env: gateEnvironment, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolvePromise(output.trim())
      : reject(new Error(`Godot version check failed (${code ?? "unknown"})\n${output}`)));
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

if (process.platform !== "darwin") {
  throw new Error("Phase 3 certification requires macOS with a visible WindowServer session");
}

await rm(failureArtifacts, { force: true, recursive: true });
await mkdir(failureArtifacts, { recursive: true });
const godot = await godotBinary();
const detectedGodotVersion = await readOutput(godot, ["--version"]);
if (detectedGodotVersion !== "4.7.stable.official.5b4e0cb0f") {
  throw new Error(`Godot 4.7.stable.official.5b4e0cb0f is required; detected ${detectedGodotVersion || "unknown"}`);
}
process.stdout.write(`[phase-3] Godot version ${detectedGodotVersion}\n`);

let passed = false;
try {
  await run("1/15 generated protocol drift", process.execPath, ["scripts/generate-godot-protocol.mjs", "--check"]);
  await run("2/15 topological package builds", pnpm, ["build"]);
  await run("3/15 ESLint", pnpm, ["lint"]);
  await run("4/15 TypeScript typecheck", pnpm, ["typecheck"]);
  await run("5/15 package unit tests", pnpm, ["exec", "vitest", "run", "packages"]);
  await withFixture("godot-mcp-phase-3-import-", async ({ project, environment }) => {
    await run("6/15 disposable fixture import and smoke", godot, ["--headless", "--editor", "--path", project, "--import"], environment);
  });
  await withFixture("godot-mcp-phase-3-protocol-", async ({ project, environment }) => {
    await mkdir(join(project, "protocol-fixtures"));
    await copyFile(join(root, "packages/protocol/fixtures/session-crypto-v1.json"), join(project, "protocol-fixtures/session-crypto-v1.json"));
    await run("7/15 runtime descriptor and proof fixture parity setup", process.execPath, ["packages/cli/dist/bin.js", "init", "--project", project], environment);
    await run("7/15 runtime descriptor and proof fixture parity", godot, ["--headless", "--path", project, "--script", "res://tests/protocol_fixture_test.gd"], environment);
  });
  await withFixture("godot-mcp-phase-3-harness-unit-", async ({ project, environment }) => {
    await run("8/15 runtime harness unit setup", process.execPath, ["packages/cli/dist/bin.js", "init", "--project", project], environment);
    await run("8/15 runtime harness deadline units", godot, ["--headless", "--path", project, "--script", "res://tests/runtime_harness_unit.gd"], environment);
  });
  await run("8/15 runtime contracts and lifecycle units", pnpm, ["exec", "vitest", "run", "packages/protocol/src/runtime.test.ts", "packages/control-plane/src/runtime", "packages/bridge-client/src/bridgeSession.test.ts"]);
  await run("9/15 authenticated runtime bridge integration", pnpm, ["exec", "vitest", "run", "tests/integration/runtime-bridge.test.ts"]);
  await run("10/15 bounded runtime capture and MCP image evidence", pnpm, ["exec", "vitest", "run", "packages/mcp-server/src/registerRuntimeTools.test.ts"]);
  await run("11/15 hostile runtime identity input and deadline matrix", pnpm, ["exec", "vitest", "run", "tests/security/runtime-hostile.test.ts"]);
  await run("12/15 crash disconnect and repeated cleanup recovery", pnpm, ["exec", "vitest", "run", "packages/control-plane/src/runtime/runtimeService.test.ts"]);
  await run("13/15 published stdio Phase 3 E2E", pnpm, ["exec", "vitest", "run", "tests/end-to-end/phase-3.test.ts"]);
  await run("14/15 full regression suite", pnpm, ["test"]);
  await run("15/15 git diff --check", "git", ["diff", "--check"]);
  passed = true;
  process.stdout.write("\n[phase-3] PASS (15/15 stages)\n");
} finally {
  if (passed) await rm(failureArtifacts, { force: true, recursive: true });
}
