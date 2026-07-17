import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import { discoverProject, ensureRuntimeDirectory, readProjectIdentity } from "@godot-mcp/control-plane";

import { runDoctor } from "../install/doctor.js";
import { findGodotBinary } from "../install/pluginState.js";

export function secureEditorArguments(project: string, sharedPort: number, attestationPath: string): string[] {
  if (!Number.isInteger(sharedPort) || sharedPort < 1 || sharedPort > 65_535) {
    throw new Error("Secure editor shared port is invalid");
  }
  if (!attestationPath) throw new Error("Secure editor launch attestation is required");
  return [
    "--editor",
    "--debug-server", `tcp://127.0.0.1:${sharedPort}`,
    "--dap-port", String(sharedPort),
    "--path", project,
    "--",
    `--godot-mcp-debug-port=${sharedPort}`,
    `--godot-mcp-dap-port=${sharedPort}`,
    "--godot-mcp-secure-editor-launch=1",
    `--godot-mcp-editor-attestation=${attestationPath}`,
  ];
}

export async function createSecureEditorLaunchAttestation(projectId: string, sharedPort: number): Promise<{ path: string; cleanup(): Promise<void> }> {
  if (!projectId || !Number.isInteger(sharedPort) || sharedPort < 1 || sharedPort > 65_535) {
    throw new Error("Secure editor launch attestation input is invalid");
  }
  const directory = await ensureRuntimeDirectory();
  const path = join(directory, `editor-launch-${randomUUID()}.json`);
  const createdAtUnixMs = Date.now();
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 1,
    projectId,
    debugPort: sharedPort,
    dapPort: sharedPort,
    createdAtUnixMs,
    expiresAtUnixMs: createdAtUnixMs + 10_000,
  })}\n`, { flag: "wx", mode: 0o600 });
  return { path, cleanup: async () => { await rm(path, { force: true }); } };
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
  const identity = await readProjectIdentity(project.rootRealPath);
  const attestation = await createSecureEditorLaunchAttestation(identity.projectId, port);
  const child = spawn(godot, secureEditorArguments(project.rootRealPath, port, attestation.path), { stdio: "inherit", env: process.env });
  return new Promise<number>((resolvePromise, reject) => {
    child.once("error", (error) => { void attestation.cleanup().finally(() => reject(error)); });
    child.once("close", (code, signal) => { void attestation.cleanup().then(() => {
      if (code !== null) resolvePromise(code);
      else reject(new Error(`Godot editor exited from signal ${signal ?? "unknown"}`));
    }, reject); });
  });
}
