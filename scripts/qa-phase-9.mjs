import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const godot = process.env.GODOT_BIN ?? "/opt/homebrew/bin/godot";
const artifacts = await mkdtemp(join(process.env.GODOT_MCP_FAILURE_ARTIFACT_DIR ?? tmpdir(), "godot-mcp-phase-9-gate-"));
const cleanupRecord = join(artifacts, "cleanup.json");
const environment = { ...process.env, GODOT_MCP_PHASE9_CLEANUP_RECORD: cleanupRecord };

async function run(label, command, args, env = environment) {
  process.stdout.write(`\n[phase-9] ${label}\n`);
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolvePromise() : reject(new Error(`${label} failed (${code ?? signal ?? "unknown"})`)));
  });
}

async function output(command, args) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let text = ""; child.stdout.on("data", (chunk) => { text += chunk; }); child.stderr.on("data", (chunk) => { text += chunk; });
    child.once("error", reject); child.once("close", (code) => code === 0 ? resolvePromise(text.trim()) : reject(new Error(text)));
  });
}

if (process.platform !== "darwin") throw new Error("Phase 9 certification requires macOS");
await access(godot, constants.X_OK);
const version = await output(godot, ["--version"]);
if (version !== "4.7.stable.official.5b4e0cb0f") throw new Error(`Exact Godot 4.7 build required; detected ${version}`);
process.stdout.write(`[phase-9] 1/16 Godot version ${version}\n`);
let passed = false;
try {
  await run("2/16 generated protocol drift", process.execPath, ["scripts/generate-godot-protocol.mjs", "--check"]);
  await run("3/16 topological package builds", pnpm, ["build"]);
  await run("4/16 ESLint", pnpm, ["lint"]);
  await run("5/16 TypeScript typecheck", pnpm, ["typecheck"]);
  await run("6/16 focused project units", pnpm, ["exec", "vitest", "run", "packages/protocol/src/projectOperations.test.ts", "packages/bridge-client/src/bridgeSession.test.ts", "packages/control-plane/src/project", "packages/mcp-server/src/registerProjectTools.test.ts", "packages/cli/src/runtime/createRuntime.test.ts"]);
  const fixtureContainer = await mkdtemp(join(tmpdir(), "godot-mcp-phase-9-import-"));
  try {
    const project = join(fixtureContainer, "project"); const runtime = join(fixtureContainer, "runtime");
    await cp(join(root, "fixtures/godot-4.7"), project, { recursive: true }); await mkdir(join(project, "addons")); await mkdir(runtime); await cp(join(root, "addons/godot_mcp"), join(project, "addons/godot_mcp"), { recursive: true });
    const external = join(fixtureContainer, "external"); await mkdir(external); await writeFile(join(external, "plugin.cfg"), "[plugin]\n"); await writeFile(join(external, "outside.svg"), "outside\n");
    await symlink(external, join(project, "addons/external")); await symlink(join(external, "outside.svg"), join(project, "linked-outside.svg"));
    const importLog = join(fixtureContainer, "import.log");
    await run("7/16 disposable import", godot, ["--headless", "--editor", "--path", project, "--import", "--log-file", importLog], { ...environment, XDG_RUNTIME_DIR: runtime });
    if (/SCRIPT ERROR:|Parse Error:|Failed to load script/u.test(await readFile(importLog, "utf8"))) throw new Error("Disposable import logged a script failure");
    const unitLog = join(fixtureContainer, "unit.log");
    await run("8/16 GDScript project operation unit", godot, ["--headless", "--path", project, "--script", "res://tests/project_operations_unit.gd", "--log-file", unitLog], { ...environment, XDG_RUNTIME_DIR: runtime });
    const unitOutput = await readFile(unitLog, "utf8");
    if (!unitOutput.includes("PHASE9_PROJECT_OPERATIONS_UNIT_OK") || /SCRIPT ERROR:|Parse Error:|Failed to load script/u.test(unitOutput)) throw new Error("GDScript project operation unit did not produce a clean marker");
  } finally { await rm(fixtureContainer, { recursive: true, force: true }); }
  await run("9/16 operation lifecycle integration", pnpm, ["exec", "vitest", "run", "packages/control-plane/src/project/projectJobService.test.ts", "packages/control-plane/src/project/projectMutationService.test.ts"]);
  await run("10/16 hostile project matrix", pnpm, ["exec", "vitest", "run", "tests/security/project-hostile.test.ts"]);
  await run("11/16 published stdio Phase 9 E2E", pnpm, ["exec", "vitest", "run", "tests/end-to-end/phase-9.test.ts", "--fileParallelism=false"]);
  await run("12/16 clean release scan and standalone smoke", process.execPath, ["scripts/phase9-fixture-export.mjs"]);
  await run("13/16 serialized full regressions", pnpm, ["exec", "vitest", "run", "--fileParallelism=false"]);
  await run("14/16 cleanup verification", process.execPath, ["scripts/verify-phase-9-cleanup.mjs", cleanupRecord]);
  await run("15/16 committed branch diff", "git", ["diff", "--check", `${process.env.GODOT_MCP_DIFF_BASE ?? "main"}...HEAD`]);
  await run("16/16 working-tree diff", "git", ["diff", "--check"]);
  if (await output("git", ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("Phase 9 working tree is not clean");
  passed = true; process.stdout.write("\n[phase-9] PASS (16/16 stages)\n");
} finally { if (passed) await rm(artifacts, { recursive: true, force: true }); }
