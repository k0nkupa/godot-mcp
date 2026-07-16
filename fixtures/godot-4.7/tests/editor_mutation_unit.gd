extends SceneTree

const EditorMutation = preload("res://addons/godot_mcp/mutation/editor_mutation.gd")
const VariantDecoder = preload("res://addons/godot_mcp/mutation/editor_variant_decoder.gd")
const BridgeClient = preload("res://addons/godot_mcp/bridge/bridge_client.gd")

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
	var reconnect := BridgeClient.new()
	reconnect._session_key = PackedByteArray([1, 2, 3])
	reconnect._session_id = "old-session"
	reconnect._send_sequence = 4
	reconnect._receive_sequence = 5
	reconnect._reset_session_state()
	assert(reconnect._session_key.is_empty() and reconnect._session_id.is_empty())
	assert(reconnect._send_sequence == 0 and reconnect._receive_sequence == 0)
	reconnect.free()
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
	assert(mutation.execute({"operation": "preview", "steps": [{
		"operation": "create_resource", "resourcePath": "res://addons/blocked.tres", "className": "Resource",
	}]}).code == "INVALID_REQUEST")
	assert(mutation.execute({"operation": "preview", "steps": [{
		"operation": "duplicate_resource", "resourcePath": "res://observation/fixture_resource.tres",
		"destinationPath": "res://.godot/blocked.tres",
	}]}).code == "INVALID_REQUEST")
	assert(mutation.execute({"operation": "preview", "steps": [{
		"operation": "duplicate_scene", "scenePath": "res://main.tscn", "destinationPath": "res://main.tscn",
	}]}).code == "CONFLICT")
	_test_file_operations(mutation)
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

func _test_file_operations(mutation: RefCounted) -> void:
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path("res://mutation"))
	_assert_file_action(mutation, {
		"operation": "create_scene", "scenePath": "res://mutation/generated_scene.tscn",
		"rootClassName": "Node2D", "rootName": "Generated",
	}, false, "res://mutation/generated_scene.tscn", "")
	_assert_file_action(mutation, {
		"operation": "create_resource", "resourcePath": "res://mutation/generated_resource.tres",
		"className": "Resource",
	}, false, "res://mutation/generated_resource.tres", "")
	_assert_file_action(mutation, {
		"operation": "duplicate_scene", "scenePath": "res://main.tscn",
		"destinationPath": "res://mutation/duplicated_scene.tscn",
	}, true, "res://main.tscn", "res://mutation/duplicated_scene.tscn")
	_assert_file_action(mutation, {
		"operation": "duplicate_resource", "resourcePath": "res://observation/fixture_resource.tres",
		"destinationPath": "res://mutation/duplicated_resource.tres",
	}, true, "res://observation/fixture_resource.tres", "res://mutation/duplicated_resource.tres")
	_copy_file("res://main.tscn", "res://mutation/move_source.tscn")
	_assert_file_action(mutation, {
		"operation": "move_scene", "scenePath": "res://mutation/move_source.tscn",
		"destinationPath": "res://mutation/moved_scene.tscn",
	}, true, "res://mutation/move_source.tscn", "res://mutation/moved_scene.tscn")
	_copy_file("res://observation/fixture_resource.tres", "res://mutation/move_source.tres")
	_assert_file_action(mutation, {
		"operation": "move_resource", "resourcePath": "res://mutation/move_source.tres",
		"destinationPath": "res://mutation/moved_resource.tres",
	}, true, "res://mutation/move_source.tres", "res://mutation/moved_resource.tres")
	_copy_file("res://main.tscn", "res://mutation/delete_scene.tscn")
	_assert_file_action(mutation, {
		"operation": "delete_scene", "scenePath": "res://mutation/delete_scene.tscn",
	}, true, "res://mutation/delete_scene.tscn", "")
	_copy_file("res://observation/fixture_resource.tres", "res://mutation/delete_resource.tres")
	_assert_file_action(mutation, {
		"operation": "delete_resource", "resourcePath": "res://mutation/delete_resource.tres",
	}, true, "res://mutation/delete_resource.tres", "")

func _assert_file_action(mutation: RefCounted, step: Dictionary, source_exists_before: bool, source_path: String, destination_path: String) -> void:
	var source_before := FileAccess.get_file_as_bytes(source_path) if source_exists_before else PackedByteArray()
	var preview: Dictionary = mutation.execute({"operation": "preview", "steps": [step]})
	assert(preview.ok and preview.data.history.kind == "global")
	assert(FileAccess.file_exists(source_path) == source_exists_before)
	if not destination_path.is_empty(): assert(not FileAccess.file_exists(destination_path))
	var apply: Dictionary = mutation.execute({
		"operation": "apply", "idempotencyKey": _new_key(),
		"expectedPlanDigest": preview.data.planDigest, "steps": [step],
	})
	assert(apply.ok)
	var operation := String(step.operation)
	var result_path := source_path if operation.begins_with("create_") else destination_path
	if operation.begins_with("delete_"):
		assert(not FileAccess.file_exists(source_path))
	elif operation.begins_with("move_"):
		assert(not FileAccess.file_exists(source_path) and FileAccess.file_exists(destination_path))
	else:
		assert(FileAccess.file_exists(result_path))
	var post_bytes := FileAccess.get_file_as_bytes(result_path) if not result_path.is_empty() and FileAccess.file_exists(result_path) else PackedByteArray()
	var undo: Dictionary = mutation.execute({"operation": "undo", "actionId": apply.data.actionId, "idempotencyKey": _new_key()})
	assert(undo.ok)
	assert(FileAccess.file_exists(source_path) == source_exists_before)
	if source_exists_before: assert(FileAccess.get_file_as_bytes(source_path) == source_before)
	if not destination_path.is_empty(): assert(not FileAccess.file_exists(destination_path))
	var redo: Dictionary = mutation.execute({"operation": "redo", "actionId": apply.data.actionId, "idempotencyKey": _new_key()})
	assert(redo.ok)
	if not result_path.is_empty() and not operation.begins_with("delete_"):
		assert(FileAccess.get_file_as_bytes(result_path) == post_bytes)
	assert(mutation.execute({"operation": "undo", "actionId": apply.data.actionId, "idempotencyKey": _new_key()}).ok)
	if source_exists_before and source_path.begins_with("res://mutation/"):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(source_path))

func _copy_file(source: String, destination: String) -> void:
	var file := FileAccess.open(destination, FileAccess.WRITE)
	assert(file != null)
	file.store_buffer(FileAccess.get_file_as_bytes(source))
	file.close()

func _new_key() -> String:
	var bytes := Crypto.new().generate_random_bytes(16)
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	var value := bytes.hex_encode()
	return "%s-%s-%s-%s-%s" % [value.substr(0, 8), value.substr(8, 4), value.substr(12, 4), value.substr(16, 4), value.substr(20, 12)]
