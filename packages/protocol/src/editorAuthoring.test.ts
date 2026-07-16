import { describe, expect, it } from "vitest";

import { EditorAuthoringStepSchema, ExtendedEditorVariantSchema } from "./editorAuthoring.js";

describe("Phase 6 authoring schemas", () => {
  it("accepts bounded extended values", () => {
    expect(ExtendedEditorVariantSchema.parse({ type: "vector2i", x: 1, y: 2 })).toEqual({ type: "vector2i", x: 1, y: 2 });
    expect(ExtendedEditorVariantSchema.parse({ type: "rect2", x: 1, y: 2, width: 3, height: 4 })).toMatchObject({ type: "rect2" });
    expect(ExtendedEditorVariantSchema.parse({ type: "packed_int32_array", values: [1, 2, 3] })).toMatchObject({ values: [1, 2, 3] });
  });

  it("accepts hash-bound source replacement", () => {
    expect(EditorAuthoringStepSchema.parse({
      operation: "replace_script",
      sourcePath: "res://authoring/behavior.gd",
      expectedSha256: "a".repeat(64),
      content: "extends Node\n",
    })).toMatchObject({ operation: "replace_script" });
  });

  it("accepts resource properties and import expectations", () => {
    expect(EditorAuthoringStepSchema.parse({
      operation: "set_resource_property",
      target: { resourcePath: "res://authoring/material.tres", propertyPath: [] },
      property: "roughness",
      value: 0.25,
      importExpectation: { importer: "texture", options: { "compress/mode": 0 } },
    })).toMatchObject({ operation: "set_resource_property" });
  });

  it("accepts stable typed composite operations", () => {
    expect(EditorAuthoringStepSchema.parse({
      operation: "configure_control_layout",
      scenePath: "res://authoring/main.tscn",
      nodePath: "Panel",
      anchors: { left: 0, top: 0, right: 1, bottom: 1 },
      offsets: { left: 8, top: 8, right: -8, bottom: -8 },
    })).toMatchObject({ operation: "configure_control_layout" });
    expect(EditorAuthoringStepSchema.parse({
      operation: "set_tile_cells",
      scenePath: "res://authoring/main.tscn",
      nodePath: "World/Tiles",
      cells: [{ coordinates: { x: 1, y: 2 }, sourceId: 0, atlasCoordinates: { x: 3, y: 4 }, alternativeTile: 0 }],
    })).toMatchObject({ operation: "set_tile_cells" });
  });

  it("defines every advertised Phase 6 operation", () => {
    const target = { resourcePath: "res://authoring/resource.tres", propertyPath: [] };
    const scene = { scenePath: "res://authoring/main.tscn", nodePath: "Target" };
    const digest = "a".repeat(64);
    const values: unknown[] = [
      { operation: "set_resource_property", target, property: "value", value: 1 },
      { operation: "set_resource_metadata", target, key: "label", value: "safe" },
      { operation: "remove_resource_metadata", target, key: "label" },
      { operation: "assign_resource_reference", target, property: "texture", referencePath: "res://icon.svg", expectedType: "Texture2D" },
      { operation: "configure_control_layout", ...scene, anchors: { left: 0, top: 0, right: 1, bottom: 1 } },
      { operation: "set_theme_item", target, itemKind: "color", themeType: "Button", itemName: "font_color", value: { type: "color", r: 1, g: 1, b: 1, a: 1 } },
      { operation: "remove_theme_item", target, itemKind: "color", themeType: "Button", itemName: "font_color" },
      { operation: "upsert_animation", target, animationName: "walk", length: 1, loopMode: "linear" },
      { operation: "remove_animation", target, animationName: "walk" },
      { operation: "upsert_animation_track", target, trackId: "position", trackType: "value", trackPath: "Sprite2D:position" },
      { operation: "remove_animation_track", target, trackId: "position" },
      { operation: "upsert_animation_key", target, trackId: "position", keyTime: 0.5, value: { type: "vector2", x: 1, y: 2 } },
      { operation: "remove_animation_key", target, trackId: "position", keyTime: 0.5 },
      { operation: "configure_animation_tree", ...scene, active: true, processCallback: "idle", parameters: { "parameters/blend_position": 0.5 } },
      { operation: "set_tile_cells", ...scene, cells: [{ coordinates: { x: 1, y: 2 }, sourceId: 0, atlasCoordinates: { x: 3, y: 4 }, alternativeTile: 0 }] },
      { operation: "erase_tile_cells", ...scene, coordinates: [{ x: 1, y: 2 }] },
      { operation: "create_custom_resource", resourcePath: "res://authoring/custom.tres", className: "FixtureResource", properties: { value: 1 } },
      { operation: "create_script", sourcePath: "res://authoring/new.gd", content: "extends Node\n" },
      { operation: "replace_script", sourcePath: "res://authoring/new.gd", expectedSha256: digest, content: "extends Node\n" },
      { operation: "create_shader", sourcePath: "res://authoring/new.gdshader", content: "shader_type canvas_item;\n" },
      { operation: "replace_shader", sourcePath: "res://authoring/new.gdshader", expectedSha256: digest, content: "shader_type canvas_item;\n" },
    ];
    expect(values.map((value) => EditorAuthoringStepSchema.parse(value).operation)).toHaveLength(21);
  });

  it.each([
    { operation: "create_script", sourcePath: "res://addons/escape.gd", content: "extends Node\n" },
    { operation: "create_shader", sourcePath: "res://shader.txt", content: "shader_type canvas_item;" },
    { operation: "replace_script", sourcePath: "res://x.gd", expectedSha256: "bad", content: "extends Node\n" },
    { operation: "set_resource_property", target: { resourcePath: "res://x.tres", propertyPath: Array(9).fill("x") }, property: "x", value: 1 },
    { operation: "create_script", sourcePath: "res://authoring/x.gd", content: "x".repeat(192 * 1024 + 1) },
  ])("rejects unsafe authoring input %#", (value) => {
    expect(() => EditorAuthoringStepSchema.parse(value)).toThrow();
  });
});
