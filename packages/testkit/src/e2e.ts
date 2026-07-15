import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { findGodotBinary } from "./godot.js";

export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface EditorProcess {
  readonly pid: number;
  readonly output: string;
  close(): Promise<void>;
}

export interface McpClientProcess {
  readonly pid: number | null;
  readonly stderr: string;
  callTool(input: { name: string; arguments?: Record<string, unknown> }): Promise<{
    structuredContent?: unknown;
    content: unknown[];
  }>;
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  close(): Promise<void>;
}

function environment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    child.once("spawn", resolvePromise);
    child.once("error", reject);
  });
}

function waitForClose(child: ChildProcess): Promise<number> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolvePromise(code ?? 1));
  });
}

export async function runCli(args: readonly string[], timeoutMs = 30_000): Promise<CliRunResult> {
  const executable = resolve(process.cwd(), "packages/cli/dist/bin.js");
  const child = spawn(process.execPath, [executable, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  await waitForSpawn(child);

  const timedOut = await Promise.race([
    waitForClose(child).then((exitCode) => ({ timedOut: false as const, exitCode })),
    new Promise<{ timedOut: true }>((resolvePromise) =>
      setTimeout(() => resolvePromise({ timedOut: true }), timeoutMs),
    ),
  ]);
  if (timedOut.timedOut) {
    child.kill("SIGKILL");
    await waitForClose(child);
    throw new Error(`CLI timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return { exitCode: timedOut.exitCode, stdout, stderr };
}

export interface LaunchEditorOptions {
  scene?: string;
  headless?: boolean;
  debugServerPort?: number;
}

export async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
  if (port < 1) throw new Error("Failed to reserve a loopback debug port");
  return port;
}

export async function launchEditor(
  project: string,
  options: LaunchEditorOptions = {},
): Promise<EditorProcess> {
  const godot = await findGodotBinary();
  if (options.scene) {
    const selectedMainEditor = options.scene.includes("3d") ? 1 : 0;
    await writeFile(
      join(project, ".godot/editor/editor_layout.cfg"),
      `[EditorNode]\n\nopen_scenes=PackedStringArray("${options.scene}")\ncurrent_scene="${options.scene}"\nselected_main_editor_idx=${selectedMainEditor}\n`,
    );
  }
  const child = spawn(godot, [
    ...((options.headless ?? true) ? ["--headless"] : []),
    "--editor",
    ...(options.debugServerPort === undefined
      ? []
      : ["--debug-server", `tcp://127.0.0.1:${options.debugServerPort}`]),
    "--path",
    project,
    ...(options.scene ? [options.scene] : []),
    ...(options.debugServerPort === undefined
      ? []
      : ["--", `--godot-mcp-debug-port=${options.debugServerPort}`]),
  ], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    output += chunk;
  });
  await waitForSpawn(child);
  let closePromise: Promise<void> | undefined;
  return {
    pid: child.pid ?? -1,
    get output(): string {
      return output;
    },
    close(): Promise<void> {
      closePromise ??= (async () => {
        if (child.exitCode !== null) return;
        child.kill("SIGTERM");
        const closed = await Promise.race([
          waitForClose(child).then(() => true),
          new Promise<boolean>((resolvePromise) => setTimeout(() => resolvePromise(false), 2_000)),
        ]);
        if (!closed && child.exitCode === null) {
          child.kill("SIGKILL");
          await Promise.race([
            waitForClose(child),
            new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1_000)),
          ]);
        }
      })();
      return closePromise;
    },
  };
}

export async function launchMcpClient(args: readonly string[]): Promise<McpClientProcess> {
  const executable = resolve(process.cwd(), "packages/cli/dist/bin.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [executable, ...args],
    cwd: process.cwd(),
    env: environment(),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: string | Buffer) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: "godot-mcp-e2e", version: "0.1.0" });
  const connected = await Promise.race([
    client.connect(transport).then(() => true),
    new Promise<boolean>((resolvePromise) => setTimeout(() => resolvePromise(false), 10_000)),
  ]);
  if (!connected) {
    const pid = transport.pid;
    if (pid) process.kill(pid, "SIGKILL");
    await transport.close().catch(() => undefined);
    throw new Error(`MCP client connection timed out\n${stderr}`);
  }

  let closePromise: Promise<void> | undefined;
  return {
    get pid(): number | null {
      return transport.pid;
    },
    get stderr(): string {
      return stderr;
    },
    async callTool(input): Promise<{ structuredContent?: unknown; content: unknown[] }> {
      const result = await client.callTool(input);
      return {
        ...(result.structuredContent === undefined
          ? {}
          : { structuredContent: result.structuredContent }),
        content: Array.isArray(result.content) ? result.content : [],
      };
    },
    async listTools(): Promise<{ tools: Array<{ name: string }> }> {
      const result = await client.listTools();
      return { tools: result.tools.map((tool) => ({ name: tool.name })) };
    },
    close(): Promise<void> {
      closePromise ??= (async () => {
        const pid = transport.pid;
        const closed = await Promise.race([
          client.close().then(() => true),
          new Promise<boolean>((resolvePromise) => setTimeout(() => resolvePromise(false), 2_000)),
        ]);
        if (!closed && pid) process.kill(pid, "SIGKILL");
        await transport.close().catch(() => undefined);
      })();
      return closePromise;
    },
  };
}
