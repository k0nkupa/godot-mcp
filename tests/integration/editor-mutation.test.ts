import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { startBridgeServer, type BridgeSession } from "@godot-mcp/bridge-client";
import { initProject } from "@godot-mcp/cli";
import { JsonlAuditSink, readProjectIdentity } from "@godot-mcp/control-plane";
import type { EditorMutationResult, EditorMutationStep } from "@godot-mcp/protocol";
import { copyFixture, findGodotBinary, runGodot } from "@godot-mcp/testkit";
import { expect, test } from "vitest";

const scene = "res://mutation/editor_mutation.tscn";

test("applies, persists, undoes, and redoes one authenticated editor mutation action", async () => {
  const project = await copyFixture();
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
      grants: { tiers: ["observe", "project_mutate"], packs: ["core", "editor"] },
      addonManifestSha256: manifest.manifestSha256,
      auditSink: new JsonlAuditSink(join(dirname(project.root), "mutation-audit.jsonl")),
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
      const scenePath = join(project.root, "mutation/editor_mutation.tscn");
      const initial = await readFile(scenePath);
	  const initialTarget = await session.request("editor.query", {
		operation: "node", scenePath: scene, nodePath: "Target", includeProperties: true,
	  });
	  const initialTree = await session.request("editor.query", {
		operation: "scene_tree", scenePath: scene, maxDepth: 8, maxNodes: 100,
	  });
      const steps: EditorMutationStep[] = [
        { operation: "set_property", scenePath: scene, nodePath: "Target", property: "position", value: { type: "vector2", x: 12, y: 34 } },
        { operation: "set_metadata", scenePath: scene, nodePath: "Target", key: "phase_5", value: "persisted" },
        { operation: "add_group", scenePath: scene, nodePath: "Target", group: "phase_5", persistent: true },
        { operation: "rename_node", scenePath: scene, nodePath: "Sibling", name: "RenamedSibling" },
        { operation: "move_node", scenePath: scene, nodePath: "Target", index: 1 },
        { operation: "create_node", scenePath: scene, parentPath: "Container", className: "Node2D", name: "Created" },
        { operation: "duplicate_node", scenePath: scene, nodePath: "Target", parentPath: "Container", name: "Duplicated" },
        { operation: "connect_signal", scenePath: scene, nodePath: ".", signal: "fixture_event", targetPath: ".", method: "_on_fixture_event", flags: 0 },
      ];
      const preview = await session.request<EditorMutationResult>("editor.mutate", { operation: "preview", steps });
      expect(preview.data).toMatchObject({ state: "previewed", history: { kind: "scene", scenePath: scene } });
      expect(await readFile(scenePath)).toEqual(initial);
      const applied = await session.request<EditorMutationResult>("editor.mutate", {
        operation: "apply",
        idempotencyKey: randomUUID(),
        expectedPlanDigest: preview.data.planDigest,
        steps,
      });
      expect(applied.data.state).toBe("applied");
      const postimage = await readFile(scenePath);
      expect(postimage).not.toEqual(initial);
      expect(postimage.toString()).toContain("persisted");
      const undone = await session.request<EditorMutationResult>("editor.mutate", {
        operation: "undo", actionId: applied.data.actionId, idempotencyKey: randomUUID(),
      });
      expect(undone.data.state).toBe("undone");
	  const undoTarget = await session.request("editor.query", {
		operation: "node", scenePath: scene, nodePath: "Target", includeProperties: true,
	  });
	  const undoTree = await session.request("editor.query", {
		operation: "scene_tree", scenePath: scene, maxDepth: 8, maxNodes: 100,
	  });
	  expect(undoTarget.data).toEqual(initialTarget.data);
	  expect(undoTree.data).toEqual(initialTree.data);
	  const undoFile = await readFile(scenePath, "utf8");
	  expect(undoFile).not.toContain("persisted");
	  expect(undoFile).not.toContain("phase_5");
	  expect(undoFile).not.toContain("Created");
      const redone = await session.request<EditorMutationResult>("editor.mutate", {
        operation: "redo", actionId: applied.data.actionId, idempotencyKey: randomUUID(),
      });
      expect(redone.data.state).toBe("redone");
      expect(await readFile(scenePath)).toEqual(postimage);
      await session.request("editor.mutate", {
        operation: "undo", actionId: applied.data.actionId, idempotencyKey: randomUUID(),
      });
	  const restoredTarget = await session.request("editor.query", {
		operation: "node", scenePath: scene, nodePath: "Target", includeProperties: true,
	  });
	  expect(restoredTarget.data).toEqual(initialTarget.data);
    } catch (error) {
      throw new Error(`${String(error)}\n${output}`);
    } finally {
      await server.close();
    }
	const finalDiff = await project.diffFromOriginal();
	expect(finalDiff, await readFile(join(project.root, "mutation/editor_mutation.tscn"), "utf8")).toEqual([]);
  } finally {
    if (editor?.exitCode === null) editor.kill("SIGTERM");
    if (originalRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = originalRuntimeDirectory;
    await project.cleanup();
  }
}, 60_000);
