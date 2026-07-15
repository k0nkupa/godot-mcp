import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";

export interface RunGodotOptions {
  cwd?: string;
  timeoutMs?: number;
}

export interface RunGodotResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface SpawnAndCollectOptions {
  cwd: string | undefined;
  timeoutMs: number;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findGodotBinary(): Promise<string> {
  const candidates = [
    process.env.GODOT_BIN,
    "/opt/homebrew/bin/godot",
    "/usr/local/bin/godot",
    ...((process.env.PATH ?? "").split(delimiter).map((entry) => join(entry, "godot"))),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of [...new Set(candidates)]) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  throw new Error("Godot executable not found; set GODOT_BIN to a Godot 4.7 binary");
}

function spawnAndCollect(
  executable: string,
  args: readonly string[],
  options: SpawnAndCollectOptions,
): Promise<RunGodotResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    }, options.timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(
          new Error(
            `Godot timed out after ${options.timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
        return;
      }
      if (code === null) {
        reject(new Error(`Godot exited without a status code (signal: ${signal ?? "unknown"})`));
        return;
      }
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

export async function runGodot(
  args: readonly string[],
  options: RunGodotOptions = {},
): Promise<RunGodotResult> {
  const executable = await findGodotBinary();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const version = await spawnAndCollect(executable, ["--version"], {
    cwd: options.cwd,
    timeoutMs: Math.min(timeoutMs, 5_000),
  });
  const detectedVersion = version.stdout.trim();
  if (version.exitCode !== 0 || !detectedVersion.startsWith("4.7.stable")) {
    throw new Error(`Godot 4.7.stable is required; detected ${detectedVersion || "unknown"}`);
  }

  return spawnAndCollect(executable, args, { cwd: options.cwd, timeoutMs });
}
