import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const failureArtifacts = process.env.GODOT_MCP_FAILURE_ARTIFACT_DIR
  ?? join(tmpdir(), "godot-mcp-phase-2-failure-artifacts");
const gateEnvironment = {
  ...process.env,
  GODOT_MCP_FAILURE_ARTIFACT_DIR: failureArtifacts,
};

async function executable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function godotBinary() {
  const candidates = [process.env.GODOT_BIN, "/opt/homebrew/bin/godot", "/usr/local/bin/godot"];
  for (const candidate of candidates) {
    if (candidate && (await executable(candidate))) return candidate;
  }
  throw new Error("Godot 4.7 executable not found; set GODOT_BIN");
}

async function run(label, command, args, options = {}) {
  process.stdout.write(`\n[phase-2] ${label}\n`);
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: options.env ?? gateEnvironment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${label} failed (${code ?? signal ?? "unknown"})`));
    });
  });
}

async function readOutput(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: gateEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise(output.trim());
      else reject(new Error(`Godot version check failed (${code ?? "unknown"})\n${output}`));
    });
  });
}

async function withFixture(prefix, callback) {
  const container = await mkdtemp(join(tmpdir(), prefix));
  const project = join(container, "project");
  const environment = {
    ...gateEnvironment,
    XDG_RUNTIME_DIR: join(container, "runtime"),
  };
  try {
    await cp(join(root, "fixtures/godot-4.7"), project, { recursive: true });
    await callback({ container, project, environment });
  } finally {
    await rm(container, { force: true, recursive: true });
  }
}

async function runProtocolFixture(godot) {
  await withFixture("godot-mcp-phase-2-protocol-", async ({ project, environment }) => {
    await mkdir(join(project, "protocol-fixtures"));
    await copyFile(
      join(root, "packages/protocol/fixtures/session-crypto-v1.json"),
      join(project, "protocol-fixtures/session-crypto-v1.json"),
    );
    await run("7/13 GDScript protocol fixture setup", process.execPath, [
      "packages/cli/dist/bin.js", "init", "--project", project,
    ], { env: environment });
    await run("7/13 GDScript protocol fixture", godot, [
      "--headless", "--path", project, "--script", "res://tests/protocol_fixture_test.gd",
    ], { env: environment });
  });
}

async function runObservationHarness(godot) {
  await withFixture("godot-mcp-phase-2-observation-", async ({ project, environment }) => {
    await run("8/13 GDScript observation harness setup", process.execPath, [
      "packages/cli/dist/bin.js", "init", "--project", project,
    ], { env: environment });
    await run("8/13 GDScript observation harness", godot, [
      "--headless", "--path", project, "--script", "res://tests/editor_observation_unit.gd",
    ], { env: environment });
  });
}

if (process.platform !== "darwin") {
  throw new Error(
    "Phase 2 certification requires macOS with a visible WindowServer session; headless capture substitution is forbidden",
  );
}
await mkdir(failureArtifacts, { recursive: true });
const godot = await godotBinary();
const detectedGodotVersion = await readOutput(godot, ["--version"]);
if (detectedGodotVersion !== "4.7.stable.official.5b4e0cb0f") {
  throw new Error(
    `Godot 4.7.stable.official.5b4e0cb0f is required; detected ${detectedGodotVersion || "unknown"}`,
  );
}
process.stdout.write(`[phase-2] Godot version ${detectedGodotVersion}\n`);
await run("1/13 generated protocol drift", process.execPath, ["scripts/generate-godot-protocol.mjs", "--check"]);
await run("2/13 topological package builds", pnpm, ["build"]);
await run("3/13 ESLint", pnpm, ["lint"]);
await run("4/13 TypeScript typecheck", pnpm, ["typecheck"]);
await run("5/13 package unit tests", pnpm, ["exec", "vitest", "run", "packages"]);
await withFixture("godot-mcp-phase-2-import-", async ({ project, environment }) => {
  await run("6/13 Godot fixture import", godot, ["--headless", "--path", project, "--import"], { env: environment });
});
await runProtocolFixture(godot);
await runObservationHarness(godot);
await run("9/13 real-editor observation integration", pnpm, [
  "exec", "vitest", "run", "tests/integration/editor-observation.test.ts",
]);
await run("10/13 visible-editor viewport integration", pnpm, [
  "exec", "vitest", "run", "tests/integration/editor-capture.test.ts",
]);
await run("11/13 observation security matrix", pnpm, [
  "exec", "vitest", "run", "tests/security",
]);
await run("12/13 published stdio Phase 2 E2E", pnpm, [
  "exec", "vitest", "run", "tests/end-to-end/phase-2.test.ts",
]);
await run("13/13 git diff --check", "git", ["diff", "--check"]);
process.stdout.write("\n[phase-2] PASS (13/13 stages)\n");
