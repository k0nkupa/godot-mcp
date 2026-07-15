import { lstat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GodotMcpException } from "../errors.js";

function invalidRuntimeDirectory(message: string): GodotMcpException {
  return new GodotMcpException({
    code: "AUTHENTICATION_FAILED",
    message,
    retryable: false,
    correlationId: "runtime-directory",
    partialEffects: false,
    rollback: "not_needed",
  });
}

export function runtimeDirectoryPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(environment.XDG_RUNTIME_DIR || tmpdir(), "godot-mcp");
}

export async function ensureRuntimeDirectory(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const path = runtimeDirectoryPath(environment);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw invalidRuntimeDirectory("Godot MCP runtime path must be a private regular directory");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw invalidRuntimeDirectory("Godot MCP runtime directory is accessible by other users");
  }
  return path;
}
