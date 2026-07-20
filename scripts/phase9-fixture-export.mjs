import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { scanArtifactDirectory } from "../packages/control-plane/dist/index.js";

const root = resolve(import.meta.dirname, "..");
const godot = process.env.GODOT_BIN ?? "/opt/homebrew/bin/godot";
const container = await mkdtemp(join(tmpdir(), "godot-mcp-phase-9-export-"));
const project = join(container, "project");
const output = join(container, "output");
const runtime = join(container, "runtime");
const environment = { ...process.env, XDG_RUNTIME_DIR: runtime };

async function run(command, args, logFile) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, env: environment, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolvePromise() : reject(new Error(`${command} failed (${code ?? signal ?? "unknown"})`)));
  });
  if (logFile) {
    const text = await readFile(logFile, "utf8");
    if (/SCRIPT ERROR:|Parse Error:|Failed to load script/u.test(text)) throw new Error(`Godot script failure in ${logFile}`);
  }
}

async function findStandalone(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findStandalone(path);
      if (nested) return nested;
    } else if (path.includes(".app/Contents/MacOS/")) return path;
  }
  return null;
}

let clean = false;
try {
  await cp(join(root, "fixtures/godot-4.7"), project, { recursive: true });
  await mkdir(join(project, "addons"), { recursive: true });
  await cp(join(root, "addons/godot_mcp"), join(project, "addons/godot_mcp"), { recursive: true });
  await Promise.all([mkdir(output), mkdir(runtime)]);
  await run(godot, ["--headless", "--editor", "--path", project, "--import", "--log-file", join(container, "import.log")], join(container, "import.log"));
  const archive = join(output, "phase9-fixture.zip");
  await run(godot, ["--headless", "--path", project, "--export-release", "Phase9 macOS", archive, "--log-file", join(container, "export.log")], join(container, "export.log"));
  const scan = await scanArtifactDirectory(output);
  if (!scan.leakFree || scan.entries.length !== 1) throw new Error(`Export leakage scan failed: ${JSON.stringify(scan.findings)}`);
  const unpacked = join(container, "unpacked");
  await mkdir(unpacked);
  await run("unzip", ["-q", archive, "-d", unpacked]);
  const standalone = await findStandalone(unpacked);
  if (!standalone) throw new Error("Exported macOS executable was not found");
  const smokeLog = join(container, "smoke.log");
  await run(standalone, ["--headless", "--log-file", smokeLog], smokeLog);
  if (!(await readFile(smokeLog, "utf8")).includes("PHASE9_STANDALONE_EXPORT_OK")) throw new Error("Standalone export smoke marker was absent");
  clean = true;
  process.stdout.write(`[phase-9] clean export ${scan.sha256} (${scan.byteLength} bytes)\n[phase-9] PHASE9_STANDALONE_EXPORT_OK\n`);
} finally {
  if (process.env.GODOT_MCP_PHASE9_CLEANUP_RECORD) {
    await writeFile(process.env.GODOT_MCP_PHASE9_CLEANUP_RECORD, `${JSON.stringify({ container, removed: true, clean })}\n`, { mode: 0o600 });
  }
  await rm(container, { force: true, recursive: true });
}
