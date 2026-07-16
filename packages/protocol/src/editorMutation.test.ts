import { describe, expect, it } from "vitest";

import { EditorMutationInputSchema } from "./editorMutation.js";

const scene = "res://mutation/editor_mutation.tscn";
const key = "019f6f52-6b15-7e21-bda3-101112131415";
const digest = "a".repeat(64);

describe("Phase 5 editor mutation schemas", () => {
  it("accepts preview and apply batches", () => {
    const steps = [{
      operation: "set_property",
      scenePath: scene,
      nodePath: "Target",
      property: "position",
      value: { type: "vector2", x: 12, y: 34 },
    }];
    expect(EditorMutationInputSchema.parse({ operation: "preview", steps })).toMatchObject({
      operation: "preview",
      steps,
    });
    expect(EditorMutationInputSchema.parse({
      operation: "apply",
      idempotencyKey: key,
      expectedPlanDigest: digest,
      steps,
    })).toMatchObject({ operation: "apply", idempotencyKey: key });
  });

  it("accepts action-scoped undo and redo", () => {
    expect(EditorMutationInputSchema.parse({
      operation: "undo",
      actionId: key,
      idempotencyKey: "019f6f52-6b15-7e21-bda3-202122232425",
    }).operation).toBe("undo");
    expect(EditorMutationInputSchema.parse({
      operation: "redo",
      actionId: key,
      idempotencyKey: "019f6f52-6b15-7e21-bda3-303132333435",
    }).operation).toBe("redo");
  });

  it("accepts the complete Phase 5 step vocabulary", () => {
    const steps = [
      { operation: "create_scene", scenePath: "res://mutation/new_scene.tscn", rootClassName: "Node2D", rootName: "Root" },
      { operation: "duplicate_scene", scenePath: scene, destinationPath: "res://mutation/copy.tscn" },
      { operation: "move_scene", scenePath: scene, destinationPath: "res://mutation/moved.tscn" },
      { operation: "delete_scene", scenePath: scene },
      { operation: "create_resource", resourcePath: "res://mutation/new.tres", className: "Resource" },
      { operation: "duplicate_resource", resourcePath: "res://mutation/source.tres", destinationPath: "res://mutation/copy.tres" },
      { operation: "move_resource", resourcePath: "res://mutation/source.tres", destinationPath: "res://mutation/moved.tres" },
      { operation: "delete_resource", resourcePath: "res://mutation/source.tres" },
      { operation: "create_node", scenePath: scene, parentPath: ".", className: "Node2D", name: "Created" },
      { operation: "duplicate_node", scenePath: scene, nodePath: "Target", parentPath: ".", name: "Copy" },
      { operation: "move_node", scenePath: scene, nodePath: "Target", index: 0 },
      { operation: "rename_node", scenePath: scene, nodePath: "Target", name: "Renamed" },
      { operation: "reparent_node", scenePath: scene, nodePath: "Target", parentPath: "Container", index: 0 },
      { operation: "delete_node", scenePath: scene, nodePath: "Target" },
      { operation: "set_property", scenePath: scene, nodePath: "Target", property: "position", value: { type: "vector2", x: 1, y: 2 } },
      { operation: "set_metadata", scenePath: scene, nodePath: "Target", key: "phase5", value: true },
      { operation: "remove_metadata", scenePath: scene, nodePath: "Target", key: "phase5" },
      { operation: "add_group", scenePath: scene, nodePath: "Target", group: "phase5", persistent: true },
      { operation: "remove_group", scenePath: scene, nodePath: "Target", group: "phase5" },
      { operation: "connect_signal", scenePath: scene, nodePath: "Target", signal: "tree_entered", targetPath: "Receiver", method: "_on_target_entered", flags: 0 },
      { operation: "disconnect_signal", scenePath: scene, nodePath: "Target", signal: "tree_entered", targetPath: "Receiver", method: "_on_target_entered" },
      { operation: "set_owner", scenePath: scene, nodePath: "Target", ownerPath: "." },
    ];
    const parsed = EditorMutationInputSchema.parse({ operation: "preview", steps });
    expect(parsed.operation).toBe("preview");
    if (parsed.operation !== "preview") throw new Error("Expected preview input");
    expect(parsed.steps).toHaveLength(22);
  });

  it("rejects traversal, subnames, unbounded batches, nonfinite values, and unknown fields", () => {
    expect(() => EditorMutationInputSchema.parse({ operation: "preview", steps: [] })).toThrow();
    expect(() => EditorMutationInputSchema.parse({
      operation: "preview",
      steps: Array.from({ length: 33 }, () => ({
        operation: "create_node",
        scenePath: scene,
        parentPath: ".",
        className: "Node",
        name: "N",
      })),
    })).toThrow();
    expect(() => EditorMutationInputSchema.parse({ operation: "preview", steps: [{ operation: "delete_node", scenePath: scene, nodePath: "../Outside" }] })).toThrow();
    expect(() => EditorMutationInputSchema.parse({ operation: "preview", steps: [{ operation: "set_property", scenePath: scene, nodePath: "Target:position", property: "position", value: 1 }] })).toThrow();
    expect(() => EditorMutationInputSchema.parse({ operation: "preview", steps: [{ operation: "set_property", scenePath: scene, nodePath: "Target", property: "position", value: Number.POSITIVE_INFINITY }] })).toThrow();
    expect(() => EditorMutationInputSchema.parse({ operation: "undo", actionId: key, idempotencyKey: key, extra: true })).toThrow();
  });
});
