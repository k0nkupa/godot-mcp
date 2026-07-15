import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

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
  process.stdout.write(`\n[phase-0-1] ${label}\n`);
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: options.env ?? process.env,
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
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise(output.trim());
      else reject(new Error(`Godot version check failed (${code ?? "unknown"})\n${output}`));
    });
  });
}

async function runGdscriptProtocolFixture(godot) {
  const container = await mkdtemp(join(tmpdir(), "godot-mcp-protocol-"));
  const project = join(container, "project");
  const environment = { ...process.env, XDG_RUNTIME_DIR: join(container, "runtime") };
  try {
    await cp(join(root, "fixtures/godot-4.7"), project, { recursive: true });
    await mkdir(join(project, "protocol-fixtures"));
    await copyFile(
      join(root, "packages/protocol/fixtures/session-crypto-v1.json"),
      join(project, "protocol-fixtures/session-crypto-v1.json"),
    );
    await run(
      "7/11 GDScript protocol fixture setup",
      process.execPath,
      ["packages/cli/dist/bin.js", "init", "--project", project],
      { env: environment },
    );
    await run(
      "7/11 GDScript protocol fixture",
      godot,
      [
        "--headless",
        "--path",
        project,
        "--script",
        "res://tests/protocol_fixture_test.gd",
      ],
      { env: environment },
    );
  } finally {
    await rm(container, { force: true, recursive: true });
  }
}

const godot = await godotBinary();
const detectedGodotVersion = await readOutput(godot, ["--version"]);
if (detectedGodotVersion !== "4.7.stable.official.5b4e0cb0f") {
  throw new Error(
    `Godot 4.7.stable.official.5b4e0cb0f is required; detected ${detectedGodotVersion || "unknown"}`,
  );
}
process.stdout.write(`[phase-0-1] Godot version ${detectedGodotVersion}\n`);
await run("1/11 generated protocol check", process.execPath, [
  "scripts/generate-godot-protocol.mjs",
  "--check",
]);
await run("2/11 topological package builds", pnpm, ["build"]);
await run("3/11 ESLint", pnpm, ["lint"]);
await run("4/11 TypeScript typecheck", pnpm, ["typecheck"]);
await run("5/11 unit tests", pnpm, ["exec", "vitest", "run", "packages"]);
await run("6/11 Godot fixture import", godot, [
  "--headless",
  "--path",
  "fixtures/godot-4.7",
  "--import",
  "--quit",
]);
await runGdscriptProtocolFixture(godot);
await run("8/11 real-editor integration tests", pnpm, [
  "exec",
  "vitest",
  "run",
  "tests/integration",
]);
await run("9/11 security tests", pnpm, [
  "exec",
  "vitest",
  "run",
  "tests/security",
]);
await run("10/11 end-to-end stdio/editor test", pnpm, [
  "exec",
  "vitest",
  "run",
  "tests/end-to-end",
]);
await run("11/11 whitespace check", "git", ["diff", "--check"]);
process.stdout.write("\n[phase-0-1] PASS\n");
