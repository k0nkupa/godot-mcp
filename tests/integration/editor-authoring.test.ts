import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { startBridgeServer, type BridgeSession } from "@godot-mcp/bridge-client";
import { initProject } from "@godot-mcp/cli";
import { JsonlAuditSink, readProjectIdentity } from "@godot-mcp/control-plane";
import { EditorMutationResultSchema, type EditorMutationResult, type EditorMutationStep } from "@godot-mcp/protocol";
import { copyFixture, findGodotBinary, runGodot, waitUntil } from "@godot-mcp/testkit";
import { expect, test } from "vitest";

const scene = "res://authoring/authoring_scene.tscn";

test("authors scene, resources, imported references, animation, and source through one authenticated editor", async () => {
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
    await writeFile(join(project.root, ".godot/editor/editor_layout.cfg"), `[EditorNode]\n\nopen_scenes=PackedStringArray("${scene}")\ncurrent_scene="${scene}"\nselected_main_editor_idx=0\n`);
    const identity = await readProjectIdentity(project.root);
    const manifest = JSON.parse(await readFile(join(project.root, ".godot/godot-mcp/install-manifest.json"), "utf8")) as { manifestSha256: string };
    const server = await startBridgeServer({
      project: identity,
      grants: { tiers: ["observe", "project_mutate"], packs: ["core", "editor"] },
      addonManifestSha256: manifest.manifestSha256,
      auditSink: new JsonlAuditSink(join(dirname(project.root), "authoring-audit.jsonl")),
    });
    try {
      editor = spawn(await findGodotBinary(), ["--headless", "--editor", "--path", project.root, scene], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      editor.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      editor.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      session = await server.waitForAttachment(15_000);
      await waitUntil(async () => (await session?.request<{ editedScene?: string }>("editor.query", { operation: "editor_state" }))?.data.editedScene === scene, 10_000, 100);
      await project.snapshot();

      const sceneStep: EditorMutationStep[] = [{
        operation: "configure_control_layout", scenePath: scene, nodePath: "UI/Panel",
        anchors: { left: 0, top: 0, right: 1, bottom: 1 }, offsets: { left: 8, top: 8, right: -8, bottom: -8 },
      }];
      const sceneAction = await apply(session, sceneStep);
      expect((await readFile(join(project.root, "authoring/authoring_scene.tscn"), "utf8"))).toContain("anchor_right = 1.0");

      const globalSteps: EditorMutationStep[] = [
        { operation: "set_resource_property", target: { resourcePath: "res://authoring/authoring_material.tres", propertyPath: [] }, property: "roughness", value: 0.25 },
        { operation: "assign_resource_reference", target: { resourcePath: "res://authoring/authoring_material.tres", propertyPath: [] }, property: "albedo_texture", referencePath: "res://icon.svg", expectedType: "Texture2D", importExpectation: { importer: "texture", options: {} } },
        { operation: "upsert_animation", target: { resourcePath: "res://authoring/authoring_animation_library.tres", propertyPath: [] }, animationName: "walk", length: 1.25, loopMode: "linear" },
      ];
      const globalAction = await apply(session, globalSteps);
      const material = await readFile(join(project.root, "authoring/authoring_material.tres"), "utf8");
      expect(material).toContain("roughness = 0.25");
      expect(material).toContain("icon.svg");
      expect(await readFile(join(project.root, "authoring/authoring_animation_library.tres"), "utf8")).toContain("walk");

      const sourceStep: EditorMutationStep[] = [{ operation: "create_script", sourcePath: "res://authoring/generated_phase6.gd", content: "extends Node\nvar phase := 6\n" }];
      const sourceAction = await apply(session, sourceStep);
      expect(await readFile(join(project.root, "authoring/generated_phase6.gd"), "utf8")).toBe(sourceStep[0]?.content);

      for (const actionId of [sourceAction, globalAction, sceneAction]) {
        const undone = await session.request<EditorMutationResult>("editor.mutate", { operation: "undo", actionId, idempotencyKey: randomUUID() });
        expect(undone.data.state).toBe("undone");
      }
    } catch (error) {
      throw new Error(`${String(error)}\n${output}`);
    } finally {
      await server.close();
    }
    expect(
      await project.diffFromOriginal(),
      await readFile(join(project.root, "authoring/authoring_scene.tscn"), "utf8"),
    ).toEqual([]);
  } finally {
    if (editor?.exitCode === null) editor.kill("SIGTERM");
    if (originalRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = originalRuntimeDirectory;
    await project.cleanup();
  }
}, 90_000);

async function apply(session: BridgeSession, steps: EditorMutationStep[]): Promise<string> {
  const preview = await session.request<EditorMutationResult>("editor.mutate", { operation: "preview", steps });
  const parsedPreview = EditorMutationResultSchema.safeParse(preview.data);
  if (!parsedPreview.success) throw new Error(JSON.stringify(parsedPreview.error.issues));
  expect(preview.data.state).toBe("previewed");
  const applied = await session.request<EditorMutationResult>("editor.mutate", {
    operation: "apply", idempotencyKey: randomUUID(), expectedPlanDigest: preview.data.planDigest, steps,
  });
  expect(applied.data.state).toBe("applied");
  if (!applied.data.actionId) throw new Error("Missing authoring action ID");
  return applied.data.actionId;
}
