import { resolve } from "node:path";

import { initProject } from "@godot-mcp/cli";
import { visibleCapabilities } from "@godot-mcp/control-plane";
import { EditorMutationInputSchema } from "@godot-mcp/protocol";
import { copyFixture, runGodot } from "@godot-mcp/testkit";
import { describe, expect, it } from "vitest";

describe("hostile Phase 6 authoring boundaries", () => {
  it.each([
    { operation: "preview", steps: [{ operation: "create_script", sourcePath: "/tmp/escape.gd", content: "extends Node\n" }] },
    { operation: "preview", steps: [{ operation: "create_script", sourcePath: "res://../escape.gd", content: "extends Node\n" }] },
    { operation: "preview", steps: [{ operation: "create_script", sourcePath: "res://addons/escape.gd", content: "extends Node\n" }] },
    { operation: "preview", steps: [{ operation: "create_script", sourcePath: "res://authoring/escape.txt", content: "extends Node\n" }] },
    { operation: "preview", steps: [{ operation: "create_script", sourcePath: "res://authoring/nul.gd", content: "extends Node\0" }] },
    { operation: "preview", steps: [{ operation: "create_script", sourcePath: "res://authoring/huge.gd", content: "x".repeat(192 * 1024 + 1) }] },
    { operation: "preview", steps: [{ operation: "replace_shader", sourcePath: "res://authoring/valid_shader.gdshader", expectedSha256: "stale", content: "shader_type canvas_item;\n" }] },
    { operation: "preview", steps: [{ operation: "set_resource_property", target: { resourcePath: "res://addons/plugin.cfg", propertyPath: [] }, property: "x", value: 1 }] },
    { operation: "preview", steps: [{ operation: "set_resource_property", target: { resourcePath: "res://authoring/x.tres", propertyPath: Array(9).fill("nested") }, property: "x", value: 1 }] },
    { operation: "preview", steps: [{ operation: "set_resource_property", target: { resourcePath: "res://authoring/x.tres", propertyPath: [] }, property: "x", value: { type: "object", id: 1 } }] },
    { operation: "preview", steps: [{ operation: "set_tile_cells", scenePath: "res://authoring/authoring_scene.tscn", nodePath: "Tiles", cells: [] }] },
    { operation: "preview", steps: [{ operation: "set_tile_cells", scenePath: "res://authoring/authoring_scene.tscn", nodePath: "Tiles", cells: Array.from({ length: 4097 }, (_, x) => ({ coordinates: { x, y: 0 }, sourceId: 0, atlasCoordinates: { x: 0, y: 0 }, alternativeTile: 0 })) }] },
    { operation: "preview", steps: [{ operation: "invoke_method", method: "queue_free" }] },
    { operation: "preview", steps: [{ operation: "scan_filesystem" }] },
    { operation: "preview", steps: [{ operation: "reimport", resourcePath: "res://icon.svg" }] },
    { operation: "preview", steps: [{ operation: "run_shell", command: "id" }] },
  ])("rejects an escalation or unbounded request before bridge dispatch %#", (input) => {
    expect(() => EditorMutationInputSchema.parse(input)).toThrow();
  });

  it("keeps authoring behind both explicit grants", () => {
    expect(visibleCapabilities({ tiers: ["observe"], packs: ["core"] }).map(({ command }) => command)).not.toContain("godot_editor");
    expect(visibleCapabilities({ tiers: ["observe", "project_mutate"], packs: ["core", "editor"] }).map(({ command }) => command)).toContain("godot_editor");
  });

  it("rejects runtime-only authoring targets without changing a disposable project", async () => {
    const project = await copyFixture();
    try {
      await initProject(project.root, resolve(process.cwd(), "addons/godot_mcp"), process.env.GODOT_BIN);
      await project.snapshot();
      for (const unit of ["authoring_resource_unit.gd", "authoring_source_unit.gd", "authoring_domains_unit.gd", "editor_authoring_transaction_unit.gd"]) {
        const result = await runGodot(["--headless", "--path", project.root, "--script", `res://tests/${unit}`], {
          timeoutMs: 20_000,
          ...(unit === "authoring_source_unit.gd" ? {
            expectedScriptFailure: {
              successMarker: "PHASE6_SOURCE_UNIT_OK",
              failureLine: /^SCRIPT ERROR: Parse Error: Expected closing "\)" after function parameters\.$/,
            },
          } : {}),
        });
        expect(result.exitCode, `${unit}\n${result.stdout}\n${result.stderr}`).toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).not.toContain("fixture-secret");
      }
      expect(await project.diffFromOriginal()).toEqual([]);
    } finally {
      await project.cleanup();
    }
  }, 60_000);
});
