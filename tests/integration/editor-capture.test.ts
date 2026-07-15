import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { startBridgeServer } from "@godot-mcp/bridge-client";
import { JsonlAuditSink, readProjectIdentity } from "@godot-mcp/control-plane";
import { initProject } from "@godot-mcp/cli";
import { copyFixture, findGodotBinary, inspectPng, runGodot } from "@godot-mcp/testkit";
import { expect, test } from "vitest";

test.each([
  ["2d" as const, "res://observation/editor_2d.tscn"],
  ["3d" as const, "res://observation/editor_3d.tscn"],
])("captures a nonblank %s editor viewport PNG", async (viewport, scene) => {
  const project = await copyFixture();
  const originalRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = join(project.root, "runtime");
  let editor: ReturnType<typeof spawn> | undefined;
  let output = "";
  let observedState: unknown;
  try {
    const imported = await runGodot(["--headless", "--editor", "--path", project.root, "--import"]);
    expect(imported.exitCode, imported.stderr).toBe(0);
    await initProject(project.root, resolve(process.cwd(), "addons/godot_mcp"), process.env.GODOT_BIN);
    await writeFile(
      join(project.root, ".godot/editor/editor_layout.cfg"),
      `[EditorNode]\n\nopen_scenes=PackedStringArray("${scene}")\ncurrent_scene="${scene}"\nselected_main_editor_idx=${viewport === "2d" ? 0 : 1}\n`,
    );
    const identity = await readProjectIdentity(project.root);
    const manifest = JSON.parse(
      await readFile(join(project.root, ".godot/godot-mcp/install-manifest.json"), "utf8"),
    ) as { manifestSha256: string };
    const server = await startBridgeServer({
      project: identity,
      grants: { tiers: ["observe"], packs: ["core"] },
      addonManifestSha256: manifest.manifestSha256,
      auditSink: new JsonlAuditSink(join(dirname(project.root), "capture-audit.jsonl")),
    });
    try {
      editor = spawn(await findGodotBinary(), ["--editor", "--path", project.root, scene], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      editor.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      editor.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      const session = await server.waitForAttachment(15_000);
      await project.snapshot();
      observedState = (await session.request("editor.query", { operation: "editor_state" })).data;
      const result = await session.request<Record<string, unknown>>(
        "editor.capture",
        { viewport, ...(viewport === "3d" ? { viewportIndex: 0 } : {}), maxWidth: 800, maxHeight: 600 },
        { timeoutMs: 15_000, maxResponseBytes: 8 * 1024 * 1024 },
      );
      expect(result.binary).toBeDefined();
      const inspected = inspectPng(result.binary ?? new Uint8Array());
      expect(inspected.width).toBeGreaterThan(64);
      expect(inspected.height).toBeGreaterThan(64);
      expect(inspected.width).toBeLessThanOrEqual(800);
      expect(inspected.height).toBeLessThanOrEqual(600);
      expect(inspected.uniqueColors).toBeGreaterThan(1);
      expect(result.data).toMatchObject({ viewport, mimeType: "image/png" });
    } catch (error) {
      throw new Error(`${String(error)}\nstate=${JSON.stringify(observedState)}\n${output}`);
    } finally {
      await server.close();
    }
    expect(await project.diffFromOriginal()).toEqual([]);
  } finally {
    if (editor?.exitCode === null) editor.kill("SIGTERM");
    if (originalRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = originalRuntimeDirectory;
    await project.cleanup();
  }
}, 45_000);
