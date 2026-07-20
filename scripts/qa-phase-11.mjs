import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const godot = process.env.GODOT_BIN ?? (process.platform === "darwin" ? "/opt/homebrew/bin/godot" : "godot");
async function run(label, command, args, env = process.env) { process.stdout.write(`\n[phase-11] ${label}\n`); await new Promise((ok, reject) => { const child = spawn(command, args, { cwd: root, env, stdio: "inherit" }); child.once("error", reject); child.once("close", (code, signal) => code === 0 ? ok() : reject(new Error(`${label} failed (${code ?? signal ?? "unknown"})`))); }); }
async function output(command, args) { return await new Promise((ok, reject) => { const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }); let value = ""; child.stdout.on("data", (chunk) => { value += chunk; }); child.stderr.on("data", (chunk) => { value += chunk; }); child.once("error", reject); child.once("close", (code) => code === 0 ? ok(value.trim()) : reject(new Error(value))); }); }

await access(godot, constants.X_OK);
if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error(`Local Phase 11 cell requires macos/arm64; detected ${process.platform}/${process.arch}`);
const version = await output(godot, ["--version"]);
if (version !== "4.7.stable.official.5b4e0cb0f") throw new Error(`Exact local Phase 11 cell requires Godot 4.7.stable.official.5b4e0cb0f; detected ${version}`);
process.stdout.write(`[phase-11] 1/15 Godot version ${version}\n`);
await run("2/15 generated protocol drift", process.execPath, ["scripts/generate-godot-protocol.mjs", "--check"]);
await run("3/15 topological builds", pnpm, ["build"]);
await run("4/15 ESLint", pnpm, ["lint"]);
await run("5/15 typecheck", pnpm, ["typecheck"]);
await run("6/15 release contract and lifecycle", pnpm, ["exec", "vitest", "run", "tests/release/release-contract.test.ts", "tests/integration/addon-release-lifecycle.test.ts", "--fileParallelism=false"]);
await run("7/15 hostile, concurrency, and stale-session regressions", pnpm, ["exec", "vitest", "run", "tests/security", "packages/bridge-client/src/bridgeSession.test.ts", "packages/control-plane/src/runtime", "--fileParallelism=false"]);
await run("8/15 complete serialized regression suite", pnpm, ["exec", "vitest", "run", "--fileParallelism=false"]);
const first = await mkdtemp(join(tmpdir(), "godot-mcp-release-a-"));
const second = await mkdtemp(join(tmpdir(), "godot-mcp-release-b-"));
try {
  await run("9/15 first release build", process.execPath, ["scripts/build-release.mjs", first]);
  await run("10/15 first release verification", process.execPath, ["scripts/verify-release.mjs", first]);
  await run("11/15 second release build", process.execPath, ["scripts/build-release.mjs", second]);
  const firstManifest = await readFile(join(first, "release-manifest.json"));
  const secondManifest = await readFile(join(second, "release-manifest.json"));
  if (!firstManifest.equals(secondManifest)) throw new Error("Release manifest is not reproducible");
  for (const line of (await readFile(join(first, "SHA256SUMS"), "utf8")).trim().split("\n")) {
    const name = line.slice(line.indexOf("  ") + 2);
    if (!(await readFile(join(first, name))).equals(await readFile(join(second, name)))) throw new Error(`Release artifact is not reproducible: ${name}`);
  }
} finally { await rm(first, { recursive: true, force: true }); await rm(second, { recursive: true, force: true }); }
await run("12/15 cleanup", process.execPath, ["scripts/verify-phase-11-cleanup.mjs"]);
await run("13/15 committed diff", "git", ["diff", "--check", `${process.env.GODOT_MCP_DIFF_BASE ?? "main"}...HEAD`]);
await run("14/15 working-tree diff", "git", ["diff", "--check"]);
if (await output("git", ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("Phase 11 working tree is not clean");
process.stdout.write("\n[phase-11] PASS (15/15 stages; publication remains a separate protected workflow)\n");
