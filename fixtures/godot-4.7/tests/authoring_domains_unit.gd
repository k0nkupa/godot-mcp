extends SceneTree

const ThemeAuthoring = preload("res://addons/godot_mcp/authoring/theme_authoring.gd")
const AnimationAuthoring = preload("res://addons/godot_mcp/authoring/animation_authoring.gd")
const TileAuthoring = preload("res://addons/godot_mcp/authoring/tile_authoring.gd")
const CustomResourceAuthoring = preload("res://addons/godot_mcp/authoring/custom_resource_authoring.gd")

var _failed := false

func _init() -> void:
	_test_control_and_theme()
	_test_animation()
	_test_tile_cells()
	_test_custom_resource()
	if not _failed: print("PHASE6_DOMAINS_UNIT_OK")
	quit(1 if _failed else 0)

func _expect(condition: bool) -> void:
	if not condition:
		_failed = true
		push_error("Phase 6 domains unit expectation failed")

func _test_control_and_theme() -> void:
	var control := Control.new()
	control.name = "Panel"
	root.add_child(control)
	var layout := ThemeAuthoring.prepare({
		"operation": "configure_control_layout", "scenePath": "res://authoring/main.tscn", "nodePath": "Panel",
		"anchors": {"left": 0.0, "top": 0.0, "right": 1.0, "bottom": 1.0},
		"offsets": {"left": 8.0, "top": 9.0, "right": -8.0, "bottom": -9.0},
	}, {"root": root})
	_expect(layout.ok)
	ThemeAuthoring.apply_step(layout.step, true)
	_expect(control.anchor_right == 1.0 and control.offset_left == 8.0)
	ThemeAuthoring.apply_step(layout.step, false)
	_expect(control.anchor_right == 0.0 and control.offset_left == 0.0)

	var theme_path := "res://mutation/phase6_theme.tres"
	var theme := Theme.new()
	_expect(ResourceSaver.save(theme, theme_path) == OK)
	var prepared := ThemeAuthoring.prepare({
		"operation": "set_theme_item", "target": {"resourcePath": theme_path, "propertyPath": []},
		"itemKind": "color", "themeType": "Button", "itemName": "font_color",
		"value": {"type": "color", "r": 1.0, "g": 0.5, "b": 0.25, "a": 1.0},
	}, {"filesystem": null})
	_expect(prepared.ok)
	ThemeAuthoring.apply_step(prepared.step, true)
	_expect(prepared.step._theme.get_color("font_color", "Button") == Color(1, 0.5, 0.25, 1))
	ThemeAuthoring.apply_step(prepared.step, false)
	_expect(not prepared.step._theme.has_color("font_color", "Button"))
	DirAccess.remove_absolute(ProjectSettings.globalize_path(theme_path))
	root.remove_child(control)
	control.free()

func _test_animation() -> void:
	var library_path := "res://mutation/phase6_library.tres"
	_expect(ResourceSaver.save(AnimationLibrary.new(), library_path) == OK)
	var prepared := AnimationAuthoring.prepare({
		"operation": "upsert_animation", "target": {"resourcePath": library_path, "propertyPath": []},
		"animationName": "walk", "length": 1.25, "loopMode": "linear",
	}, {"filesystem": null})
	_expect(prepared.ok)
	AnimationAuthoring.apply_step(prepared.step, true)
	_expect(prepared.step._library.has_animation("walk"))
	_expect(prepared.step._library.get_animation("walk").length == 1.25)
	AnimationAuthoring.apply_step(prepared.step, false)
	_expect(not prepared.step._library.has_animation("walk"))
	DirAccess.remove_absolute(ProjectSettings.globalize_path(library_path))

	var animation_path := "res://mutation/phase6_animation.tres"
	_expect(ResourceSaver.save(Animation.new(), animation_path) == OK)
	var track := AnimationAuthoring.prepare({
		"operation": "upsert_animation_track", "target": {"resourcePath": animation_path, "propertyPath": []},
		"trackId": "position", "trackType": "value", "trackPath": "Sprite2D:position",
	}, {"filesystem": null})
	_expect(track.ok)
	AnimationAuthoring.apply_step(track.step, true)
	_expect(track.step._animation.get_track_count() == 1)
	_expect(track.step._animation.track_get_path(0) == NodePath("Sprite2D:position"))
	_expect(ResourceSaver.save(track.step._animation, animation_path) == OK)
	var key := AnimationAuthoring.prepare({
		"operation": "upsert_animation_key", "target": {"resourcePath": animation_path, "propertyPath": []},
		"trackId": "position", "keyTime": 0.5, "value": {"type": "vector2", "x": 4.0, "y": 5.0},
	}, {"filesystem": null})
	_expect(key.ok)
	AnimationAuthoring.apply_step(key.step, true)
	_expect(key.step._animation.track_get_key_value(0, 0) == Vector2(4, 5))
	AnimationAuthoring.apply_step(key.step, false)
	_expect(key.step._animation.track_get_key_count(0) == 0)
	AnimationAuthoring.apply_step(track.step, false)
	_expect(track.step._animation.get_track_count() == 0)
	DirAccess.remove_absolute(ProjectSettings.globalize_path(animation_path))

	var tree := AnimationTree.new()
	tree.name = "AnimationTree"
	root.add_child(tree)
	var tree_step := AnimationAuthoring.prepare({
		"operation": "configure_animation_tree", "scenePath": "res://authoring/main.tscn", "nodePath": "AnimationTree",
		"active": false, "processCallback": "manual", "rootMotionTrack": "Character:position",
		"parameters": {},
	}, {"root": root, "filesystem": null})
	_expect(tree_step.ok)
	AnimationAuthoring.apply_step(tree_step.step, true)
	_expect(tree.callback_mode_process == AnimationTree.ANIMATION_PROCESS_MANUAL)
	_expect(tree.root_motion_track == NodePath("Character:position"))
	AnimationAuthoring.apply_step(tree_step.step, false)
	root.remove_child(tree)
	tree.free()

func _test_tile_cells() -> void:
	var layer := TileMapLayer.new()
	layer.name = "Tiles"
	layer.tile_set = TileSet.new()
	layer.tile_set.tile_size = Vector2i(16, 16)
	var image := Image.create(16, 16, false, Image.FORMAT_RGBA8)
	image.fill(Color.WHITE)
	var atlas := TileSetAtlasSource.new()
	atlas.texture = ImageTexture.create_from_image(image)
	atlas.texture_region_size = Vector2i(16, 16)
	atlas.create_tile(Vector2i.ZERO)
	_expect(layer.tile_set.add_source(atlas, 0) == 0)
	root.add_child(layer)
	var set_cell := TileAuthoring.prepare({
		"operation": "set_tile_cells", "scenePath": "res://authoring/main.tscn", "nodePath": "Tiles",
		"cells": [{"coordinates": {"x": 2, "y": 3}, "sourceId": 0, "atlasCoordinates": {"x": 0, "y": 0}, "alternativeTile": 0}],
	}, {"root": root})
	_expect(set_cell.ok)
	if set_cell.ok:
		TileAuthoring.apply_step(set_cell.step, true)
		_expect(layer.get_cell_source_id(Vector2i(2, 3)) == 0)
		TileAuthoring.apply_step(set_cell.step, false)
		_expect(layer.get_cell_source_id(Vector2i(2, 3)) == -1)
	var prepared := TileAuthoring.prepare({
		"operation": "erase_tile_cells", "scenePath": "res://authoring/main.tscn", "nodePath": "Tiles",
		"coordinates": [{"x": 2, "y": 3}],
	}, {"root": root})
	_expect(prepared.ok)
	TileAuthoring.apply_step(prepared.step, true)
	_expect(layer.get_cell_source_id(Vector2i(2, 3)) == -1)
	TileAuthoring.apply_step(prepared.step, false)
	_expect(layer.get_cell_source_id(Vector2i(2, 3)) == -1)
	root.remove_child(layer)
	layer.free()

func _test_custom_resource() -> void:
	var prepared := CustomResourceAuthoring.prepare({
		"operation": "create_custom_resource", "resourcePath": "res://mutation/generated_custom.tres",
		"className": "FixtureResource", "properties": {"value": 7, "label": "phase-6"},
	}, {"classRegistry": {"FixtureResource": {
		"scriptPath": "res://authoring/custom_resource.gd", "base": "Resource",
		"exports": {"label": "String", "value": "int"},
	}}})
	_expect(prepared.ok)
	var text: String = prepared.prepared.desiredBytes.get_string_from_utf8()
	_expect(text.contains("script = ExtResource(\"1_script\")"))
	_expect(text.find("label = \"phase-6\"") < text.find("value = 7"))
	_expect(not text.contains("_init"))
	_expect(CustomResourceAuthoring.prepare({
		"operation": "create_custom_resource", "resourcePath": "res://mutation/unknown.tres",
		"className": "Unknown", "properties": {},
	}, {"classRegistry": {}}).code == "TARGET_NOT_FOUND")
