import { describe, expect, it } from "vitest";

import { EditorCaptureInputSchema, EditorQueryInputSchema } from "./editor.js";

describe("Phase 2 editor schemas", () => {
  it("accepts the six bounded query variants", () => {
    expect(EditorQueryInputSchema.parse({ operation: "editor_state" })).toEqual({
      operation: "editor_state",
    });
    expect(
      EditorQueryInputSchema.parse({ operation: "scene_tree", maxDepth: 32, maxNodes: 1000 })
        .operation,
    ).toBe("scene_tree");
    expect(
      EditorQueryInputSchema.parse({
        operation: "node",
        scenePath: "res://observation/editor_2d.tscn",
        nodePath: "Canvas/Label",
      }).operation,
    ).toBe("node");
    expect(
      EditorQueryInputSchema.parse({
        operation: "resources",
        prefix: "res://observation",
        limit: 2000,
      }).operation,
    ).toBe("resources");
    expect(
      EditorQueryInputSchema.parse({
        operation: "project_settings",
        prefix: "rendering/",
        limit: 200,
      }).operation,
    ).toBe("project_settings");
    expect(
      EditorQueryInputSchema.parse({
        operation: "diagnostics",
        levels: ["warning", "error"],
        limit: 500,
      }).operation,
    ).toBe("diagnostics");
  });

  it("rejects paths and bounds outside Phase 2", () => {
    expect(() =>
      EditorQueryInputSchema.parse({
        operation: "node",
        scenePath: "/tmp/x.tscn",
        nodePath: ".",
      }),
    ).toThrow();
    expect(() =>
      EditorQueryInputSchema.parse({ operation: "scene_tree", maxNodes: 1001 }),
    ).toThrow();
    expect(() =>
      EditorQueryInputSchema.parse({ operation: "resources", prefix: "res://../secret" }),
    ).toThrow();
    expect(() =>
      EditorQueryInputSchema.parse({
        operation: "node",
        scenePath: "res://scene.tscn",
        nodePath: "/root/EditorNode",
      }),
    ).toThrow();
    expect(() =>
      EditorQueryInputSchema.parse({
        operation: "node",
        scenePath: "res://scene.tscn",
        nodePath: "Child:secret_property",
      }),
    ).toThrow();
  });

  it("accepts bounded captures and rejects invalid viewport combinations", () => {
    expect(EditorCaptureInputSchema.parse({ viewport: "2d" })).toEqual({
      viewport: "2d",
      maxWidth: 1280,
      maxHeight: 720,
    });
    expect(EditorCaptureInputSchema.parse({ viewport: "3d", viewportIndex: 3 })).toMatchObject({
      viewport: "3d",
      viewportIndex: 3,
    });
    expect(() => EditorCaptureInputSchema.parse({ viewport: "2d", viewportIndex: 1 })).toThrow();
    expect(() => EditorCaptureInputSchema.parse({ viewport: "3d", viewportIndex: 4 })).toThrow();
    expect(() => EditorCaptureInputSchema.parse({ viewport: "2d", maxWidth: 2049 })).toThrow();
  });
});
