import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { GodotMcpException } from "../errors.js";

const execFileAsync = promisify(execFile);
const ENVIRONMENT_ALLOWLIST = ["HOME", "LANG", "LC_ALL", "LC_CTYPE", "PATH", "TMPDIR"] as const;

export interface RuntimeArgumentsInput {
  projectRoot: string;
  debugPort: number;
  descriptorPath: string;
}

export function godotRuntimeArguments(input: RuntimeArgumentsInput): string[] {
  return [
    "--path",
    input.projectRoot,
    "--scene",
    "res://addons/godot_mcp/runtime/runtime_harness.tscn",
    "--remote-debug",
    `tcp://127.0.0.1:${input.debugPort}`,
    "--",
    `--godot-mcp-runtime-descriptor=${input.descriptorPath}`,
  ];
}

export function scrubRuntimeEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    ENVIRONMENT_ALLOWLIST.flatMap((name) => {
      const value = environment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

async function processFingerprint(pid: number): Promise<string> {
  const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
  const started = stdout.trim();
  if (!started) throw new Error("Owned process start time is unavailable");
  return `${pid}:${started}`;
}

function waitForExit(child: ChildProcess): Promise<number> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

export interface OwnedRuntimeProcess {
  readonly pid: number;
  readonly fingerprint: string;
  stop(graceMs?: number): Promise<void>;
  wait(): Promise<number>;
}

export class OwnedGodotProcess implements OwnedRuntimeProcess {
  private stopPromise: Promise<void> | undefined;

  private constructor(
    private readonly child: ChildProcess,
    readonly pid: number,
    readonly fingerprint: string,
  ) {}

  static async launch(input: RuntimeArgumentsInput & { godotBin: string; environment?: NodeJS.ProcessEnv }): Promise<OwnedGodotProcess> {
    const child = spawn(input.godotBin, godotRuntimeArguments(input), {
      env: scrubRuntimeEnvironment(input.environment ?? process.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const pid = child.pid;
    if (!pid) throw new Error("Godot runtime did not report a PID");
    return new OwnedGodotProcess(child, pid, await processFingerprint(pid));
  }

  wait(): Promise<number> {
    return waitForExit(this.child);
  }

  stop(graceMs = 2_000): Promise<void> {
    this.stopPromise ??= (async () => {
      if (this.child.exitCode !== null) return;
      const current = await processFingerprint(this.pid).catch(() => "");
      if (current !== this.fingerprint) {
        throw new GodotMcpException({
          code: "CONFLICT",
          message: "Owned runtime process fingerprint changed; refusing to signal",
          retryable: false,
          correlationId: this.fingerprint,
          partialEffects: false,
          rollback: "not_attempted",
        });
      }
      this.child.kill("SIGTERM");
      const stopped = await Promise.race([
        waitForExit(this.child).then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
      ]);
      if (!stopped && this.child.exitCode === null) {
        const beforeKill = await processFingerprint(this.pid).catch(() => "");
        if (beforeKill !== this.fingerprint) throw new Error("Owned runtime fingerprint changed before escalation");
        this.child.kill("SIGKILL");
        await waitForExit(this.child);
      }
    })();
    return this.stopPromise;
  }
}
