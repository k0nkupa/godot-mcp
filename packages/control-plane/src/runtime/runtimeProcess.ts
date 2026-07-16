import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { GodotMcpException } from "../errors.js";

const execFileAsync = promisify(execFile);
const ENVIRONMENT_ALLOWLIST = ["HOME", "LANG", "LC_ALL", "LC_CTYPE", "PATH", "TMPDIR", "XDG_RUNTIME_DIR"] as const;

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

export function lsofShowsLoopbackListener(output: string, pid: number, port: number): boolean {
  const lines = output.split(/\r?\n/);
  const ownsProcess = lines.includes(`p${pid}`);
  const endpoints = [`n127.0.0.1:${port}`, `n[::1]:${port}`, `nlocalhost:${port}`];
  return ownsProcess && endpoints.some((endpoint) => lines.includes(endpoint));
}

export async function assertLoopbackListenerOwnedByProcess(pid: number, port: number): Promise<void> {
  let output = "";
  try {
    const result = await execFileAsync(process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof", [
      "-nP", "-a", "-p", String(pid), `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn",
    ]);
    output = result.stdout;
  } catch {
    // lsof exits nonzero when the requested process does not own that listener.
  }
  if (lsofShowsLoopbackListener(output, pid, port)) return;
  throw new GodotMcpException({
    code: "CONFLICT",
    message: "The configured Godot debugger port is not the editor's loopback listener; relaunch the editor with an explicit available debug-server port",
    retryable: false,
    correlationId: `${pid}:${port}`,
    partialEffects: false,
    rollback: "not_needed",
  });
}

async function processFingerprint(pid: number): Promise<string> {
  const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
  const started = stdout.trim();
  if (!started) throw new Error("Owned process start time is unavailable");
  return `${pid}:${started}`;
}

export function childHasExited(child: Pick<ChildProcess, "exitCode" | "signalCode">): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess): Promise<number> {
  if (childHasExited(child)) return Promise.resolve(child.exitCode ?? 1);
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
  diagnostics?(): string;
}

export class OwnedGodotProcess implements OwnedRuntimeProcess {
  private stopPromise: Promise<void> | undefined;
  private output = "";

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
    let fingerprint: string;
    try {
      fingerprint = await processFingerprint(pid);
    } catch (error) {
      if (!childHasExited(child)) child.kill("SIGKILL");
      await waitForExit(child).catch(() => undefined);
      throw error;
    }
    const owned = new OwnedGodotProcess(child, pid, fingerprint);
    const append = (chunk: Buffer | string): void => {
      owned.output = `${owned.output}${chunk.toString()}`.slice(-64 * 1024);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    return owned;
  }

  diagnostics(): string {
    return this.output;
  }

  wait(): Promise<number> {
    return waitForExit(this.child);
  }

  stop(graceMs = 2_000): Promise<void> {
    this.stopPromise ??= (async () => {
      if (childHasExited(this.child)) return;
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
      if (!stopped && !childHasExited(this.child)) {
        const beforeKill = await processFingerprint(this.pid).catch(() => "");
        if (beforeKill !== this.fingerprint) throw new Error("Owned runtime fingerprint changed before escalation");
        this.child.kill("SIGKILL");
        await waitForExit(this.child);
      }
    })();
    return this.stopPromise;
  }
}
