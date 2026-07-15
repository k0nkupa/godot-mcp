import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { discoverProject } from "@godot-mcp/control-plane";

import { updateProjectPostimage } from "./addonManifest.js";

export type PluginStateAction = "enable" | "disable";

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findGodotBinary(explicit?: string): Promise<string> {
  const candidates = [
    explicit,
    process.env.GODOT_BIN,
    "/opt/homebrew/bin/godot",
    "/usr/local/bin/godot",
    ...((process.env.PATH ?? "").split(delimiter).map((entry) => join(entry, "godot"))),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of [...new Set(candidates)]) {
    if (await executable(candidate)) return candidate;
  }
  throw new Error("Godot executable not found; set GODOT_BIN to a Godot 4.7 binary");
}

export function runProcess(
  command: string,
  args: readonly string[],
  timeoutMs = 30_000,
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`Process timed out after ${timeoutMs}ms`));
      } else if (code === null) {
        reject(new Error("Process exited without a status code"));
      } else {
        resolvePromise({ exitCode: code, stdout, stderr });
      }
    });
  });
}

export async function godotVersion(godotBin?: string): Promise<string> {
  const binary = await findGodotBinary(godotBin);
  const result = await runProcess(binary, ["--version"], 5_000);
  const version = result.stdout.trim();
  if (result.exitCode !== 0 || !version.startsWith("4.7.stable")) {
    throw new Error(`Godot 4.7.stable is required; detected ${version || "unknown"}`);
  }
  return version;
}

export async function setPluginState(
  projectInput: string,
  action: PluginStateAction,
  godotBin?: string,
): Promise<void> {
  const project = await discoverProject(projectInput);
  const binary = await findGodotBinary(godotBin);
  await godotVersion(binary);
  const helper = fileURLToPath(new URL("../../godot/plugin_state.gd", import.meta.url));
  const result = await runProcess(binary, [
    "--headless",
    "--path",
    project.rootRealPath,
    "--script",
    helper,
    "--",
    action,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`Godot failed to ${action} the addon: ${result.stderr || result.stdout}`);
  }
  await updateProjectPostimage(project.rootRealPath);
}
