import { spawn } from "node:child_process";
import { createServer } from "node:net";

import { discoverProject } from "@godot-mcp/control-plane";

import { runDoctor } from "../install/doctor.js";
import { findGodotBinary } from "../install/pluginState.js";

export function secureEditorArguments(project: string, sharedPort: number): string[] {
  if (!Number.isInteger(sharedPort) || sharedPort < 1 || sharedPort > 65_535) {
    throw new Error("Secure editor shared port is invalid");
  }
  return [
    "--editor",
    "--debug-server", `tcp://127.0.0.1:${sharedPort}`,
    "--dap-port", String(sharedPort),
    "--path", project,
    "--",
    `--godot-mcp-debug-port=${sharedPort}`,
    `--godot-mcp-dap-port=${sharedPort}`,
    "--godot-mcp-secure-editor-launch=1",
  ];
}

async function reserveSharedPort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Could not reserve a secure editor port"));
        return;
      }
      resolvePromise(address.port);
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
  return port;
}

export async function launchSecureEditor(projectInput: string, explicitGodot?: string): Promise<number> {
  const project = await discoverProject(projectInput);
  const godot = await findGodotBinary(explicitGodot);
  const doctor = await runDoctor(project.rootRealPath, godot);
  if (!doctor.healthy) throw new Error("Godot MCP installation is unhealthy; run godot-mcp doctor before editor");
  const port = await reserveSharedPort();
  const child = spawn(godot, secureEditorArguments(project.rootRealPath, port), { stdio: "inherit", env: process.env });
  return new Promise<number>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== null) resolvePromise(code);
      else reject(new Error(`Godot editor exited from signal ${signal ?? "unknown"}`));
    });
  });
}
