import { resolve } from "node:path";

import { initProject } from "@godot-mcp/cli";
import { visibleCapabilities } from "@godot-mcp/control-plane";
import { EditorMutationInputSchema } from "@godot-mcp/protocol";
import { copyFixture, runGodot } from "@godot-mcp/testkit";
import { describe, expect, it } from "vitest";

const scene = "res://mutation/editor_mutation.tscn";

describe("hostile editor mutation boundaries", () => {
  it.each([
    { operation: "preview", steps: [] },
    { operation: "preview", steps: [{ operation: "delete_scene", scenePath: "/tmp/escape.tscn" }] },
    { operation: "preview", steps: [{ operation: "delete_scene", scenePath: "file:///tmp/escape.tscn" }] },
    { operation: "preview", steps: [{ operation: "delete_scene", scenePath: "res://../escape.tscn" }] },
    { operation: "preview", steps: [{ operation: "delete_node", scenePath: scene, nodePath: "../Outside" }] },
    { operation: "preview", steps: [{ operation: "delete_node", scenePath: scene, nodePath: "Target:position" }] },
    { operation: "preview", steps: [{ operation: "set_property", scenePath: scene, nodePath: "Target", property: "position", value: Number.POSITIVE_INFINITY }] },
    { operation: "preview", steps: [{ operation: "invoke_method", scenePath: scene, nodePath: ".", method: "free" }] },
    { operation: "preview", steps: Array.from({ length: 33 }, (_, index) => ({ operation: "create_node", scenePath: scene, parentPath: ".", className: "Node", name: `N${index}` })) },
    { operation: "undo", actionId: "00000000-0000-4000-8000-000000000000", idempotencyKey: "00000000-0000-4000-8000-000000000001", extra: true },
  ])("rejects hostile input %# before bridge dispatch", (input) => {
    expect(() => EditorMutationInputSchema.parse(input)).toThrow();
  });

  it("does not expose godot_editor without both explicit grants", () => {
    expect(visibleCapabilities({ tiers: ["observe"], packs: ["core"] }).map((policy) => policy.command)).not.toContain("godot_editor");
    expect(visibleCapabilities({ tiers: ["observe", "project_mutate"], packs: ["core"] }).map((policy) => policy.command)).not.toContain("godot_editor");
    expect(visibleCapabilities({ tiers: ["observe"], packs: ["core", "editor"] }).map((policy) => policy.command)).not.toContain("godot_editor");
    expect(visibleCapabilities({ tiers: ["observe", "project_mutate"], packs: ["core", "editor"] }).map((policy) => policy.command)).toContain("godot_editor");
  });

  it("rejects protected and conflicting project files in disposable Godot units", async () => {
    const project = await copyFixture();
    try {
      await initProject(project.root, resolve(process.cwd(), "addons/godot_mcp"), process.env.GODOT_BIN);
      await project.snapshot();
      const result = await runGodot(
        ["--headless", "--path", project.root, "--script", "res://tests/editor_mutation_unit.gd"],
        { timeoutMs: 20_000 },
      );
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("GODOT_MCP_EDITOR_MUTATION_UNIT_OK");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("fixture-secret");
      expect(await project.diffFromOriginal()).toEqual([]);
    } finally {
      await project.cleanup();
    }
  }, 30_000);
});
