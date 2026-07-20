import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { projectProcessFingerprint } from "../project/projectProcess.js";
import { childHasExited, shouldRefuseProcessSignal } from "../runtime/runtimeProcess.js";

export interface UnsafeFixtureProcessHandle {
  readonly pid: number;
  readonly fingerprint: string;
  wait(): Promise<number>;
  stop(graceMs?: number): Promise<void>;
  diagnostics(): Buffer;
  outputExceeded(): boolean;
}

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function waitForExit(child: ChildProcess): Promise<number> {
  if (childHasExited(child)) return Promise.resolve(child.exitCode ?? 1);
  return new Promise((resolveWait, reject) => { child.once("error", reject); child.once("close", (code) => resolveWait(code ?? 1)); });
}

export class UnsafeFixtureProcess implements UnsafeFixtureProcessHandle {
  private output = Buffer.alloc(0);
  private exceeded = false;
  private stopPromise: Promise<void> | undefined;

  private constructor(private readonly child: ChildProcess, readonly pid: number, readonly fingerprint: string) {}

  static async launch(input: { godotBin: string; projectRoot: string; scriptPath: string; isolationRoot: string; environment?: NodeJS.ProcessEnv }): Promise<UnsafeFixtureProcess> {
    const home = join(input.isolationRoot, "home");
    const runtime = join(input.isolationRoot, "runtime");
    const config = join(home, ".config"); const cache = join(home, ".cache"); const data = join(home, ".local/share"); const temporary = join(input.isolationRoot, "tmp");
    await Promise.all([home, runtime, config, cache, data, temporary].map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
    const source = input.environment ?? process.env;
    const env: Record<string, string> = {
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: cache,
      XDG_DATA_HOME: data,
      XDG_RUNTIME_DIR: runtime,
      TMPDIR: temporary,
      ...(source.PATH ? { PATH: source.PATH } : {}),
      ...(source.LANG ? { LANG: source.LANG } : {}),
    };
    const child = spawn(input.godotBin, ["--headless", "--path", input.projectRoot, "--script", input.scriptPath], { env, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolveSpawn, reject) => { child.once("spawn", resolveSpawn); child.once("error", reject); });
    if (!child.pid) throw new Error("Unsafe fixture process did not report a PID");
    let fingerprint: string;
    try {
      fingerprint = await projectProcessFingerprint(child.pid);
    } catch (error) {
      if (childHasExited(child)) fingerprint = `${child.pid}:exited:${child.exitCode ?? "unknown"}`;
      else { child.kill("SIGKILL"); await waitForExit(child).catch(() => undefined); throw error; }
    }
    const owned = new UnsafeFixtureProcess(child, child.pid, fingerprint);
    const append = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_OUTPUT_BYTES - owned.output.byteLength;
      if (remaining > 0) owned.output = Buffer.concat([owned.output, bytes.subarray(0, remaining)]);
      if (bytes.byteLength > remaining && !owned.exceeded) { owned.exceeded = true; void owned.stop().catch(() => undefined); }
    };
    child.stdout?.on("data", append); child.stderr?.on("data", append);
    return owned;
  }

  diagnostics(): Buffer { return Buffer.from(this.output); }
  outputExceeded(): boolean { return this.exceeded; }
  wait(): Promise<number> { return waitForExit(this.child); }

  stop(graceMs = 1_000): Promise<void> {
    if (!this.stopPromise) this.stopPromise = (async () => {
      if (childHasExited(this.child)) return;
      const current = await projectProcessFingerprint(this.pid).catch(() => "");
      if (shouldRefuseProcessSignal(this.child, current, this.fingerprint)) throw new Error("Unsafe process identity changed; refusing to signal");
      this.child.kill("SIGTERM");
      const stopped = await Promise.race([waitForExit(this.child).then(() => true), new Promise<boolean>((resolveWait) => setTimeout(() => resolveWait(false), graceMs))]);
      if (!stopped && !childHasExited(this.child)) {
        const beforeKill = await projectProcessFingerprint(this.pid).catch(() => "");
        if (shouldRefuseProcessSignal(this.child, beforeKill, this.fingerprint)) throw new Error("Unsafe process identity changed before escalation");
        this.child.kill("SIGKILL"); await waitForExit(this.child);
      }
    })();
    return this.stopPromise;
  }
}
