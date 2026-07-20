import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, ".."); const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"; const godot = process.env.GODOT_BIN ?? "/opt/homebrew/bin/godot";
async function run(label, command, args, env = process.env) { process.stdout.write(`\n[phase-10] ${label}\n`); await new Promise((resolvePromise, reject) => { const child = spawn(command, args, { cwd: root, env, stdio: "inherit" }); child.once("error", reject); child.once("close", (code, signal) => code === 0 ? resolvePromise() : reject(new Error(`${label} failed (${code ?? signal ?? "unknown"})`))); }); }
async function output(command, args) { return await new Promise((resolvePromise, reject) => { const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }); let text = ""; child.stdout.on("data", (chunk) => { text += chunk; }); child.stderr.on("data", (chunk) => { text += chunk; }); child.once("error", reject); child.once("close", (code) => code === 0 ? resolvePromise(text.trim()) : reject(new Error(text))); }); }
if (process.platform !== "darwin") throw new Error("Phase 10 certification requires macOS"); await access(godot, constants.X_OK); const version = await output(godot, ["--version"]); if (version !== "4.7.stable.official.5b4e0cb0f") throw new Error(`Exact Godot 4.7 required; detected ${version}`); process.stdout.write(`[phase-10] 1/16 Godot version ${version}\n`);
await run("2/16 generated protocol drift", process.execPath, ["scripts/generate-godot-protocol.mjs", "--check"]);
await run("3/16 topological builds", pnpm, ["build"]); await run("4/16 ESLint", pnpm, ["lint"]); await run("5/16 typecheck", pnpm, ["typecheck"]);
await run("6/16 unsafe protocol and policy", pnpm, ["exec", "vitest", "run", "packages/protocol/src/unsafeFixture.test.ts", "packages/control-plane/src/policy", "packages/mcp-server/src/registerUnsafeTools.test.ts"]);
await run("7/16 registration copy and activation", pnpm, ["exec", "vitest", "run", "packages/control-plane/src/unsafe/unsafeFixtureAuthority.test.ts"]);
await run("8/16 separate unsafe process", pnpm, ["exec", "vitest", "run", "packages/control-plane/src/unsafe/unsafeFixtureService.test.ts", "-t", "runs arbitrary"]);
await run("9/16 cancellation expiry and residue", pnpm, ["exec", "vitest", "run", "packages/control-plane/src/unsafe"]);
await run("10/16 extension SDK", pnpm, ["exec", "vitest", "run", "packages/control-plane/src/extensions", "packages/mcp-server/src/registerExtensionTools.test.ts"]);
await run("11/16 hostile authority and audit matrix", pnpm, ["exec", "vitest", "run", "packages/control-plane/src/unsafe", "packages/mcp-server/src/registerUnsafeTools.test.ts"]);
await run("12/16 published stdio Phase 10 E2E", pnpm, ["exec", "vitest", "run", "tests/end-to-end/phase-10.test.ts", "--fileParallelism=false"]);
await run("13/16 serialized regressions", pnpm, ["exec", "vitest", "run", "--fileParallelism=false"]); await run("14/16 cleanup", process.execPath, ["scripts/verify-phase-10-cleanup.mjs"]);
await run("15/16 committed diff", "git", ["diff", "--check", `${process.env.GODOT_MCP_DIFF_BASE ?? "main"}...HEAD`]); await run("16/16 working-tree diff", "git", ["diff", "--check"]); if (await output("git", ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("Phase 10 working tree is not clean"); process.stdout.write("\n[phase-10] PASS (16/16 stages)\n");
