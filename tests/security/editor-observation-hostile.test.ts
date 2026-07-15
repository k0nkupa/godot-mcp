import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { initProject } from "@godot-mcp/cli";
import { EvidenceStore } from "@godot-mcp/control-plane";
import {
  BridgeCommandChunkSchema,
  EditorCaptureInputSchema,
  EditorQueryInputSchema,
} from "@godot-mcp/protocol";
import { copyFixture, runGodot } from "@godot-mcp/testkit";
import { describe, expect, it } from "vitest";

describe("hostile editor observation boundaries", () => {
  it.each([
    { operation: "node", scenePath: "/tmp/escape.tscn", nodePath: "." },
    { operation: "node", scenePath: "file:///tmp/escape.tscn", nodePath: "." },
    { operation: "node", scenePath: "res://../escape.tscn", nodePath: "." },
    { operation: "node", scenePath: "res://safe.tscn", nodePath: "../Escape" },
    { operation: "scene_tree", maxDepth: 33 },
    { operation: "scene_tree", maxNodes: 1001 },
    { operation: "resources", limit: 2001 },
    { operation: "diagnostics", limit: 501 },
    { operation: "project_settings", prefix: "network/" },
  ])("rejects hostile query input %# before bridge dispatch", (input) => {
    expect(() => EditorQueryInputSchema.parse(input)).toThrow();
  });

  it.each([
    { viewport: "2d", viewportIndex: 0 },
    { viewport: "3d", viewportIndex: 4 },
    { viewport: "2d", maxWidth: 2049 },
    { viewport: "2d", maxHeight: 0 },
  ])("rejects hostile capture input %# before bridge dispatch", (input) => {
    expect(() => EditorCaptureInputSchema.parse(input)).toThrow();
  });

  it("rejects oversized and malformed chunk declarations", () => {
    const valid = {
      requestId: "019f644c-1379-79c0-825e-66a4b7653bd1",
      index: 0,
      total: 1,
      sha256: "a".repeat(64),
      data: "AA==",
    };
    expect(BridgeCommandChunkSchema.parse(valid)).toEqual(valid);
    expect(() => BridgeCommandChunkSchema.parse({ ...valid, index: 16 })).toThrow();
    expect(() => BridgeCommandChunkSchema.parse({ ...valid, total: 17 })).toThrow();
    expect(() => BridgeCommandChunkSchema.parse({ ...valid, sha256: "not-a-digest" })).toThrow();
    expect(() => BridgeCommandChunkSchema.parse({ ...valid, data: "x".repeat(700_001) })).toThrow();
  });

  it("rejects non-PNG and decoded captures over eight MiB", async () => {
    const project = await copyFixture();
    try {
      const evidence = new EvidenceStore(project.root);
      await expect(
        evidence.putPng("session_12345678", Buffer.alloc(32), {
          viewport: "2d",
          width: 1,
          height: 1,
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      const oversized = Buffer.alloc(8 * 1024 * 1024 + 1);
      oversized.set(Buffer.from("89504e470d0a1a0a", "hex"));
      await expect(
        evidence.putPng("session_12345678", oversized, {
          viewport: "2d",
          width: 2048,
          height: 2048,
        }),
      ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    } finally {
      await project.cleanup();
    }
  });

  it("enforces queue capacity, expired deadlines, chunking, and redaction in Godot", async () => {
    const project = await copyFixture();
    try {
      await initProject(project.root, resolve(process.cwd(), "addons/godot_mcp"), process.env.GODOT_BIN);
      const projectPath = `${project.root}/project.godot`;
      const before = createHash("sha256").update(await readFile(projectPath)).digest("hex");
      const result = await runGodot(
        ["--headless", "--path", project.root, "--script", "res://tests/editor_observation_unit.gd"],
        { timeoutMs: 15_000 },
      );
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("GODOT_MCP_EDITOR_OBSERVATION_UNIT_OK");
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined).not.toContain("abc123");
      expect(combined).not.toContain("/Users/example");
      const after = createHash("sha256").update(await readFile(projectPath)).digest("hex");
      expect(after).toBe(before);
    } finally {
      await project.cleanup();
    }
  }, 25_000);
});
