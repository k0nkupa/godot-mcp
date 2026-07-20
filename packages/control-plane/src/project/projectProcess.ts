import { execFile, spawn, type ChildProcess } from "node:child_process";
import { isAbsolute, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { GodotMcpException } from "../errors.js";
import { childHasExited, shouldRefuseProcessSignal, type OwnedRuntimeProcess } from "../runtime/runtimeProcess.js";

const execFileAsync = promisify(execFile);
const ENVIRONMENT_ALLOWLIST = [
  "HOME", "LANG", "LC_ALL", "LC_CTYPE", "PATH", "TMPDIR", "XDG_RUNTIME_DIR",
  "DOTNET_ROOT", "JAVA_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT",
] as const;
const PRESET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_. -]{0,63}$/;

export type ProjectProcessInput =
  | { operation: "import"; projectRoot: string }
  | { operation: "run"; projectRoot: string; headless: boolean; scenePath?: string }
  | { operation: "build"; projectRoot: string }
  | { operation: "export"; projectRoot: string; artifactRoot: string; mode: "release" | "debug" | "pack"; preset: string; outputPath: string };

function validateProjectRoot(projectRoot: string): void {
  if (!isAbsolute(projectRoot) || projectRoot.includes("\0")) throw new TypeError("Project root must be an absolute path");
}

export function projectGodotArguments(input: ProjectProcessInput): string[] {
  validateProjectRoot(input.projectRoot);
  if (input.operation === "import") return ["--headless", "--editor", "--path", input.projectRoot, "--import"];
  if (input.operation === "run") {
    if (input.scenePath !== undefined && (
      !input.scenePath.startsWith("res://") ||
      !input.scenePath.endsWith(".tscn") ||
      input.scenePath.length > 512 ||
      input.scenePath.includes("\0") ||
      input.scenePath.slice(6).split("/").includes("..")
    )) throw new TypeError("Project run scene is invalid");
    return [
      ...(input.headless ? ["--headless"] : []),
      "--path", input.projectRoot,
      ...(input.scenePath ? ["--scene", input.scenePath] : []),
    ];
  }
  if (input.operation === "build") return ["--headless", "--path", input.projectRoot, "--build-solutions", "--quit"];
  if (!PRESET_PATTERN.test(input.preset)) throw new TypeError("Export preset name is invalid");
  const artifactRoot = resolve(input.artifactRoot);
  const outputPath = resolve(input.outputPath);
  if (outputPath === artifactRoot || !outputPath.startsWith(`${artifactRoot}${sep}`)) throw new TypeError("Export output must stay inside the owned artifact root");
  const flag = input.mode === "release" ? "--export-release" : input.mode === "debug" ? "--export-debug" : "--export-pack";
  return ["--headless", "--path", input.projectRoot, flag, input.preset, outputPath];
}

export function scrubProjectEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(ENVIRONMENT_ALLOWLIST.flatMap((name) => {
    const value = environment[name];
    return value === undefined ? [] : [[name, value]];
  }));
}

export async function projectProcessFingerprint(pid: number): Promise<string> {
  const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
  const started = stdout.trim();
  if (!started) throw new Error("Owned project process start time is unavailable");
  return `${pid}:${started}`;
}

function waitForExit(child: ChildProcess): Promise<number> {
  if (childHasExited(child)) return Promise.resolve(child.exitCode ?? 1);
  return new Promise((resolveWait, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveWait(code ?? 1));
  });
}

export class OwnedProjectProcess implements OwnedRuntimeProcess {
  private stopPromise: Promise<void> | undefined;
  private output = "";

  private constructor(
    private readonly child: ChildProcess,
    readonly pid: number,
    readonly fingerprint: string,
  ) {}

  static async launch(input: ProjectProcessInput & { godotBin: string; environment?: NodeJS.ProcessEnv }): Promise<OwnedProjectProcess> {
    const child = spawn(input.godotBin, projectGodotArguments(input), {
      env: scrubProjectEnvironment(input.environment ?? process.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolveSpawn, reject) => {
      child.once("spawn", resolveSpawn);
      child.once("error", reject);
    });
    const pid = child.pid;
    if (!pid) throw new Error("Godot project operation did not report a PID");
    let fingerprint: string;
    try {
      fingerprint = await projectProcessFingerprint(pid);
    } catch (error) {
      if (!childHasExited(child)) child.kill("SIGKILL");
      await waitForExit(child).catch(() => undefined);
      throw error;
    }
    const owned = new OwnedProjectProcess(child, pid, fingerprint);
    const append = (chunk: Buffer | string): void => {
      owned.output = `${owned.output}${chunk.toString()}`.slice(-4 * 1024 * 1024);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("exit", (code, signal) => append(`\n[godot project operation exited: ${signal ?? `code ${code ?? "unknown"}`}]\n`));
    return owned;
  }

  diagnostics(): string {
    return this.output;
  }

  wait(): Promise<number> {
    return waitForExit(this.child);
  }

  stop(graceMs = 2_000): Promise<void> {
    if (!this.stopPromise) {
      const activeStop = (async () => {
        if (childHasExited(this.child)) return;
        const current = await projectProcessFingerprint(this.pid).catch(() => "");
        if (shouldRefuseProcessSignal(this.child, current, this.fingerprint)) {
          throw new GodotMcpException({
            code: "CONFLICT",
            message: "Owned project process fingerprint changed; refusing to signal",
            retryable: false,
            correlationId: this.fingerprint,
            partialEffects: false,
            rollback: "not_attempted",
          });
        }
        if (childHasExited(this.child)) return;
        this.child.kill("SIGTERM");
        const stopped = await Promise.race([
          waitForExit(this.child).then(() => true),
          new Promise<boolean>((resolveTimeout) => setTimeout(() => resolveTimeout(false), graceMs)),
        ]);
        if (!stopped && !childHasExited(this.child)) {
          const beforeKill = await projectProcessFingerprint(this.pid).catch(() => "");
          if (shouldRefuseProcessSignal(this.child, beforeKill, this.fingerprint)) throw new Error("Owned project process fingerprint changed before escalation");
          if (childHasExited(this.child)) return;
          this.child.kill("SIGKILL");
          await waitForExit(this.child);
        }
      })();
      this.stopPromise = activeStop;
      void activeStop.catch(() => {
        if (this.stopPromise === activeStop) this.stopPromise = undefined;
      });
    }
    return this.stopPromise;
  }
}

export async function recoverOwnedProjectProcess(pid: number, fingerprint: string): Promise<"stopped" | "missing" | "ambiguous"> {
  const current = await projectProcessFingerprint(pid).catch(() => "");
  if (!current) return "missing";
  if (current !== fingerprint) return "ambiguous";
  try { process.kill(pid, "SIGTERM"); } catch { return "ambiguous"; }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
    const observed = await projectProcessFingerprint(pid).catch(() => "");
    if (!observed) return "stopped";
    if (observed !== fingerprint) return "ambiguous";
  }
  const beforeKill = await projectProcessFingerprint(pid).catch(() => "");
  if (!beforeKill) return "stopped";
  if (beforeKill !== fingerprint) return "ambiguous";
  try { process.kill(pid, "SIGKILL"); } catch { return "ambiguous"; }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
    const observed = await projectProcessFingerprint(pid).catch(() => "");
    if (!observed) return "stopped";
    if (observed !== fingerprint) return "ambiguous";
  }
  return "ambiguous";
}
