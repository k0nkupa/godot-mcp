import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createSecureEditorLaunchAttestation, secureEditorArguments } from "./editor.js";

describe("secure editor launch", () => {
  it("forces the native DAP endpoint to collide with the authenticated editor debugger", () => {
    expect(secureEditorArguments("/private/project", 45678, "/private/runtime/editor-launch-id.json")).toEqual([
      "--editor",
      "--debug-server", "tcp://127.0.0.1:45678",
      "--dap-port", "45678",
      "--path", "/private/project",
      "--",
      "--godot-mcp-debug-port=45678",
      "--godot-mcp-dap-port=45678",
      "--godot-mcp-secure-editor-launch=1",
      "--godot-mcp-editor-attestation=/private/runtime/editor-launch-id.json",
    ]);
  });

  it("rejects invalid shared ports", () => {
    expect(() => secureEditorArguments("/private/project", 0, "/private/attestation.json")).toThrow();
    expect(() => secureEditorArguments("/private/project", 65_536, "/private/attestation.json")).toThrow();
  });

  it("creates a short-lived owner-only one-use launch attestation", async () => {
    const previousRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    const root = await mkdtemp(join(tmpdir(), "godot-mcp-editor-launch-"));
    process.env.XDG_RUNTIME_DIR = root;
    try {
      const material = await createSecureEditorLaunchAttestation("project-id", 45678);
      const metadata = await lstat(material.path);
      const document = JSON.parse(await readFile(material.path, "utf8")) as Record<string, unknown>;
      expect(metadata.isFile()).toBe(true);
      expect(metadata.mode & 0o077).toBe(0);
      expect(document).toMatchObject({ schemaVersion: 1, projectId: "project-id", debugPort: 45678, dapPort: 45678 });
      expect(Number(document.expiresAtUnixMs) - Number(document.createdAtUnixMs)).toBe(10_000);
      await material.cleanup();
      await expect(readFile(material.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previousRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previousRuntimeDirectory;
      await rm(root, { recursive: true, force: true });
    }
  });
});
