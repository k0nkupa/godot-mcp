extends SceneTree

const EditorMutation = preload("res://addons/godot_mcp/mutation/editor_mutation.gd")

class FakeEditor:
	extends RefCounted
	var roots: Array[Node]

	func _init(root_node: Node) -> void:
		roots = [root_node]

	func get_open_scene_roots() -> Array[Node]: return roots
	func get_edited_scene_root() -> Node: return roots[0]
	func get_resource_filesystem() -> Variant: return null
	func save_scene() -> Error: return OK

var _failed := false

func _init() -> void:
	var packed: PackedScene = load("res://main.tscn")
	var scene_root := packed.instantiate()
	root.add_child(scene_root)
	var undo_redo := UndoRedo.new()
	var mutation := EditorMutation.new(FakeEditor.new(scene_root), undo_redo, ProjectSettings.globalize_path("res://"), func() -> int: return 6)
	_test_source_transaction(mutation)
	_test_resource_transaction(mutation)
	_test_scene_transaction(mutation, scene_root)
	mutation.clear()
	undo_redo.clear_history(false)
	root.remove_child(scene_root)
	scene_root.free()
	undo_redo.free()
	if not _failed: print("PHASE6_AUTHORING_TRANSACTION_UNIT_OK")
	quit(1 if _failed else 0)

func _test_source_transaction(mutation: RefCounted) -> void:
	var path := "res://mutation/phase6_integrated.gd"
	DirAccess.remove_absolute(ProjectSettings.globalize_path(path))
	var step := {"operation": "create_script", "sourcePath": path, "content": "extends Node\nvar phase := 6\n"}
	var preview: Dictionary = mutation.execute({"operation": "preview", "steps": [step]})
	_expect(preview.ok and preview.data.history.kind == "global")
	if not preview.ok: return
	var apply: Dictionary = mutation.execute({"operation": "apply", "idempotencyKey": _key(), "expectedPlanDigest": preview.data.planDigest, "steps": [step]})
	_expect(apply.ok and FileAccess.file_exists(path))
	if not apply.ok: return
	_expect(mutation.execute({"operation": "undo", "actionId": apply.data.actionId, "idempotencyKey": _key()}).ok)
	_expect(not FileAccess.file_exists(path))

func _test_resource_transaction(mutation: RefCounted) -> void:
	var path := "res://mutation/fixture_resource.tres"
	var before := FileAccess.get_file_as_bytes(path)
	var step := {
		"operation": "set_resource_property", "target": {"resourcePath": path, "propertyPath": []},
		"property": "resource_name", "value": "phase-6-integrated",
	}
	var preview: Dictionary = mutation.execute({"operation": "preview", "steps": [step]})
	_expect(preview.ok and preview.data.history.kind == "global")
	if not preview.ok: return
	var apply: Dictionary = mutation.execute({"operation": "apply", "idempotencyKey": _key(), "expectedPlanDigest": preview.data.planDigest, "steps": [step]})
	_expect(apply.ok)
	if not apply.ok: return
	var loaded: Resource = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
	_expect(loaded.resource_name == "phase-6-integrated")
	_expect(mutation.execute({"operation": "undo", "actionId": apply.data.actionId, "idempotencyKey": _key()}).ok)
	_expect(FileAccess.get_file_as_bytes(path) == before)

func _test_scene_transaction(mutation: RefCounted, scene_root: Node) -> void:
	var label: Control = scene_root.get_node("StatusLabel")
	var before := label.anchor_right
	var step := {
		"operation": "configure_control_layout", "scenePath": "res://main.tscn", "nodePath": "StatusLabel",
		"anchors": {"left": 0.0, "top": 0.0, "right": 1.0, "bottom": 0.0},
	}
	var preview: Dictionary = mutation.execute({"operation": "preview", "steps": [step]})
	_expect(preview.ok and preview.data.history.kind == "scene")
	if not preview.ok: return
	var apply: Dictionary = mutation.execute({"operation": "apply", "idempotencyKey": _key(), "expectedPlanDigest": preview.data.planDigest, "steps": [step]})
	_expect(apply.ok and label.anchor_right == 1.0)
	if not apply.ok: return
	_expect(mutation.execute({"operation": "undo", "actionId": apply.data.actionId, "idempotencyKey": _key()}).ok)
	_expect(label.anchor_right == before)

func _expect(condition: bool) -> void:
	if not condition:
		_failed = true
		push_error("Phase 6 authoring transaction unit expectation failed")

func _key() -> String:
	var bytes := Crypto.new().generate_random_bytes(16)
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	var value := bytes.hex_encode()
	return "%s-%s-%s-%s-%s" % [value.substr(0, 8), value.substr(8, 4), value.substr(12, 4), value.substr(16, 4), value.substr(20, 12)]
