import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { startBridgeServer, type BridgeSession } from "@godot-mcp/bridge-client";
import { initProject } from "@godot-mcp/cli";
import { JsonlAuditSink, readProjectIdentity } from "@godot-mcp/control-plane";
import { copyFixture, findGodotBinary, runGodot, waitUntil } from "@godot-mcp/testkit";
import { expect, test } from "vitest";

test("queries bounded truth from an open editor scene without changing the project", async () => {
  const project = await copyFixture();
  const scene = "res://observation/editor_2d.tscn";
  const originalRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = join(project.root, "runtime");
  let editor: ReturnType<typeof spawn> | undefined;
  let output = "";
  let session: BridgeSession | undefined;
  try {
    const imported = await runGodot(["--headless", "--editor", "--path", project.root, "--import"]);
    expect(imported.exitCode, imported.stderr).toBe(0);
    await initProject(project.root, resolve(process.cwd(), "addons/godot_mcp"), process.env.GODOT_BIN);
    await writeFile(
      join(project.root, ".godot/editor/editor_layout.cfg"),
      `[EditorNode]\n\nopen_scenes=PackedStringArray("${scene}")\ncurrent_scene="${scene}"\nselected_main_editor_idx=0\n`,
    );
    const identity = await readProjectIdentity(project.root);
    const manifest = JSON.parse(
      await readFile(join(project.root, ".godot/godot-mcp/install-manifest.json"), "utf8"),
    ) as { manifestSha256: string };
    const server = await startBridgeServer({
      project: identity,
      grants: { tiers: ["observe"], packs: ["core"] },
      addonManifestSha256: manifest.manifestSha256,
      auditSink: new JsonlAuditSink(join(dirname(project.root), "observation-audit.jsonl")),
    });
    try {
      editor = spawn(await findGodotBinary(), ["--headless", "--editor", "--path", project.root, scene], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      editor.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      editor.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      session = await server.waitForAttachment(15_000);
      await project.snapshot();

      let state: Awaited<ReturnType<typeof session.request<Record<string, unknown>>>> | undefined;
      await waitUntil(async () => {
        state = await session?.request<Record<string, unknown>>("editor.query", { operation: "editor_state" });
        return state?.data.editedScene === scene;
      }, 10_000, 100);
      expect(state.data).toMatchObject({ editedScene: scene, openScenes: [scene], unsavedScenes: [] });
      await expect(
        session.request("editor.query", {
          operation: "scene_tree",
          scenePath: "res://observation/editor_3d.tscn",
        }),
      ).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
      await expect(
        session.request("editor.query", {
          operation: "node",
          scenePath: scene,
          nodePath: "/root/EditorNode",
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

      const tree = await session.request<{ nodes: Array<Record<string, unknown>>; truncated: boolean }>(
        "editor.query",
        { operation: "scene_tree", scenePath: scene, maxDepth: 1, maxNodes: 3 },
      );
      expect(tree.data.nodes.map((node) => node.nodePath)).toEqual([".", "Backdrop", "FixtureLabel"]);
      expect(tree.data.truncated).toBe(true);

      const node = await session.request<Record<string, unknown>>("editor.query", {
        operation: "node",
        scenePath: scene,
        nodePath: "ObservedNode",
        includeProperties: true,
      });
      expect(node.data).toMatchObject({
        nodePath: "ObservedNode",
        className: "Node2D",
        groups: expect.arrayContaining(["observable", "ui"]),
        script: { path: "res://observation/fixture_script.gd" },
      });
      expect(JSON.stringify(node.data)).toContain("fixture_event");
      expect(JSON.stringify(node.data)).toContain("phase-2-2d");
      expect(JSON.stringify(node.data)).toContain("fixture_resource.tres");
      expect(JSON.stringify(node.data)).not.toContain("push_warning");
      expect(JSON.stringify(node.data)).not.toContain("fixture-secret");
      expect(JSON.stringify(node.data)).toContain("[redacted]");

      const resources = await session.request<{ resources: Array<{ path: string }> }>("editor.query", {
        operation: "resources",
        prefix: "res://observation",
        limit: 20,
      });
      expect(resources.data.resources.map((resource) => resource.path)).toEqual(
        expect.arrayContaining([
          "res://observation/editor_2d.tscn",
          "res://observation/editor_3d.tscn",
          "res://observation/fixture_resource.tres",
          "res://observation/fixture_script.gd",
        ]),
      );
      const scripts = await session.request<{
        resources: Array<{ path: string }>;
        nextCursor: string;
        truncated: boolean;
      }>("editor.query", {
        operation: "resources",
        prefix: "res://observation",
        kinds: ["script"],
        limit: 1,
      });
      expect(scripts.data).toMatchObject({
        resources: [{ path: "res://observation/fixture_script.gd" }],
        nextCursor: "",
        truncated: false,
      });

      const settings = await session.request<{ settings: Array<{ name: string }> }>("editor.query", {
        operation: "project_settings",
        prefix: "rendering/",
        limit: 5,
      });
      expect(settings.data.settings.length).toBeGreaterThan(0);
      await expect(
        session.request("editor.query", { operation: "project_settings", prefix: "network/" }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

      const diagnostics = await session.request<{ records: Array<Record<string, unknown>> }>("editor.query", {
        operation: "diagnostics",
        afterSequence: 0,
        levels: ["warning"],
        limit: 50,
      });
      const diagnosticText = JSON.stringify(diagnostics.data.records);
      expect(diagnosticText).toContain("phase-2 fixture diagnostic");
    } catch (error) {
      throw new Error(`${String(error)}\n${output}`);
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
