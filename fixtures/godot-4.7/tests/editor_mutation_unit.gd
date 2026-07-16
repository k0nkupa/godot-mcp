extends SceneTree

const EditorMutation = preload("res://addons/godot_mcp/mutation/editor_mutation.gd")
const VariantDecoder = preload("res://addons/godot_mcp/mutation/editor_variant_decoder.gd")

class FakeEditor:
	extends RefCounted
	var roots: Array[Node]

	func _init(root: Node) -> void:
		roots = [root]

	func get_open_scene_roots() -> Array[Node]:
		return roots

	func get_edited_scene_root() -> Node:
		return roots[0]

	func get_resource_filesystem() -> Variant:
		return null

	func save_scene() -> Error:
		return OK

func _init() -> void:
	var decoded := VariantDecoder.decode({"type": "vector2", "x": 1.5, "y": 2.25})
	assert(decoded.ok and decoded.value == Vector2(1.5, 2.25))
	assert(VariantDecoder.decode({"type": "color", "r": 0.1, "g": 0.2, "b": 0.3, "a": 1.0}).value is Color)
	assert(VariantDecoder.decode({"type": "unknown", "value": 1}).code == "INVALID_REQUEST")
	assert(VariantDecoder.decode(NAN).code == "INVALID_REQUEST")
	assert(VariantDecoder.decode([[[[[[[[[1]]]]]]]]]).code == "PAYLOAD_TOO_LARGE")

	var packed: PackedScene = load("res://main.tscn")
	var root_node := packed.instantiate()
	root.add_child(root_node)
	var undo_redo := UndoRedo.new()
	var mutation := EditorMutation.new(FakeEditor.new(root_node), undo_redo, ProjectSettings.globalize_path("res://"), func() -> int: return 1)
	var arguments := {
		"operation": "preview",
		"steps": [{
			"operation": "set_property",
			"scenePath": "res://main.tscn",
			"nodePath": "StatusLabel",
			"property": "text",
			"value": "phase-5-preview",
		}],
	}
	var preview: Dictionary = mutation.execute(arguments)
	assert(preview.ok)
	assert(preview.data.state == "previewed")
	assert(String(preview.data.planDigest).length() == 64)
	assert(preview.data.history == {"kind": "scene", "scenePath": "res://main.tscn"})
	assert(root_node.get_node("StatusLabel").text == "fixture-ready")
	assert(mutation.execute(arguments).data.planDigest == preview.data.planDigest)
	var apply: Dictionary = mutation.execute({
		"operation": "apply",
		"idempotencyKey": "019f6f52-6b15-7e21-bda3-101112131415",
		"expectedPlanDigest": preview.data.planDigest,
		"steps": arguments.steps,
	})
	assert(apply.ok and apply.data.state == "applied")
	assert(root_node.get_node("StatusLabel").text == "phase-5-preview")
	var undo: Dictionary = mutation.execute({
		"operation": "undo", "actionId": apply.data.actionId,
		"idempotencyKey": "019f6f52-6b15-7e21-bda3-202122232425",
	})
	assert(undo.ok and undo.data.state == "undone")
	assert(root_node.get_node("StatusLabel").text == "fixture-ready")
	var redo: Dictionary = mutation.execute({
		"operation": "redo", "actionId": apply.data.actionId,
		"idempotencyKey": "019f6f52-6b15-7e21-bda3-303132333435",
	})
	assert(redo.ok and redo.data.state == "redone")
	assert(root_node.get_node("StatusLabel").text == "phase-5-preview")
	assert(mutation.execute({"operation": "undo", "actionId": "019f6f52-6b15-7e21-bda3-404142434445", "idempotencyKey": "019f6f52-6b15-7e21-bda3-505152535455"}).code == "CONFLICT")
	assert(mutation.execute({"operation": "preview", "steps": []}).code == "INVALID_REQUEST")
	assert(mutation.execute({"operation": "preview", "steps": [{
		"operation": "delete_node", "scenePath": "res://main.tscn", "nodePath": "../Outside",
	}]}).code == "INVALID_REQUEST")
	assert(mutation.execute({"operation": "preview", "steps": [{
		"operation": "set_property", "scenePath": "res://missing.tscn", "nodePath": ".", "property": "name", "value": "x",
	}]}).code == "TARGET_NOT_FOUND")
	assert(mutation.execute({"operation": "preview", "steps": [
		{"operation": "set_property", "scenePath": "res://main.tscn", "nodePath": "StatusLabel", "property": "text", "value": "x"},
		{"operation": "create_resource", "resourcePath": "res://mutation/new.tres", "className": "Resource"},
	]}).code == "CONFLICT")
	mutation.clear()
	undo_redo.clear_history(false)
	root.remove_child(root_node)
	root_node.free()
	mutation = null
	undo_redo.free()
	undo_redo = null
	packed = null
	print("GODOT_MCP_EDITOR_MUTATION_UNIT_OK")
	quit(0)
