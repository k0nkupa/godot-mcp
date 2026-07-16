@tool
class_name GodotMcpEditorMutation
extends RefCounted

const CanonicalJson = preload("res://addons/godot_mcp/bridge/canonical_json.gd")
const VariantDecoder = preload("res://addons/godot_mcp/mutation/editor_variant_decoder.gd")
const VariantEncoder = preload("res://addons/godot_mcp/observation/variant_encoder.gd")
const MAX_STEPS := 32
const FILE_OPERATIONS := ["create_scene", "duplicate_scene", "move_scene", "delete_scene", "create_resource", "duplicate_resource", "move_resource", "delete_resource"]

var _editor: Variant
var _undo_redo: Variant
var _project_root: String
var _session_generation: Callable

func _init(editor: Variant, undo_redo: Variant, project_root: String, session_generation: Callable) -> void:
	_editor = editor
	_undo_redo = undo_redo
	_project_root = project_root
	_session_generation = session_generation

func execute(arguments: Dictionary) -> Dictionary:
	if String(arguments.get("operation", "")) != "preview":
		return _error("INVALID_REQUEST", "Phase 5 mutation operation is not implemented")
	return _preview(arguments)

func clear() -> void:
	_editor = null
	_undo_redo = null

func _preview(arguments: Dictionary) -> Dictionary:
	var steps: Array = arguments.get("steps", [])
	if steps.is_empty() or steps.size() > MAX_STEPS:
		return _error("INVALID_REQUEST", "Editor mutation batch must contain 1 to 32 steps")
	var history_kind := ""
	var scene_path := ""
	var preconditions: Array[Dictionary] = []
	var changes: Array[Dictionary] = []
	for step_value in steps:
		if typeof(step_value) != TYPE_DICTIONARY:
			return _error("INVALID_REQUEST", "Editor mutation step must be an object")
		var step: Dictionary = step_value
		var operation := String(step.get("operation", ""))
		var file_step := operation in FILE_OPERATIONS
		var requested_history := "global" if file_step else "scene"
		if history_kind.is_empty(): history_kind = requested_history
		if history_kind != requested_history:
			return _error("CONFLICT", "One mutation batch cannot mix scene and global undo histories")
		var validated := _validate_file_step(step) if file_step else _validate_node_step(step)
		if not validated.ok:
			return validated
		if requested_history == "scene":
			var current_scene := String(step.get("scenePath", ""))
			if scene_path.is_empty(): scene_path = current_scene
			if scene_path != current_scene:
				return _error("CONFLICT", "One mutation batch cannot span multiple scene undo histories")
		preconditions.append(validated.precondition)
		changes.append(validated.change)
	var history := {"kind": "global"} if history_kind == "global" else {"kind": "scene", "scenePath": scene_path}
	var digest_input := {
		"steps": steps,
		"preconditions": preconditions,
		"history": history,
		"godotVersion": Engine.get_version_info().string,
		"sessionGeneration": int(_session_generation.call()) if _session_generation.is_valid() else 0,
	}
	var plan_digest := _sha256(CanonicalJson.encode(_tag_floats(digest_input)))
	var targets: Array = preconditions.map(func(item: Dictionary) -> Dictionary: return item.target)
	return {"ok": true, "data": {
		"state": "previewed", "planDigest": plan_digest, "history": history,
		"preconditions": preconditions, "changes": changes, "warnings": [],
		"audit": {"targetIdentities": targets, "preconditions": preconditions, "idempotencyKeySha256": null, "partialEffects": false, "rollback": "not_needed"},
	}}

func _validate_node_step(step: Dictionary) -> Dictionary:
	var operation := String(step.get("operation", ""))
	var supported := ["create_node", "duplicate_node", "move_node", "rename_node", "reparent_node", "delete_node", "set_property", "set_metadata", "remove_metadata", "add_group", "remove_group", "connect_signal", "disconnect_signal", "set_owner"]
	if operation not in supported:
		return _error("INVALID_REQUEST", "Unknown editor mutation operation")
	var scene_path := String(step.get("scenePath", ""))
	if not _valid_scene_path(scene_path): return _error("INVALID_REQUEST", "Invalid scene path")
	var root := _find_open_root(scene_path)
	if root == null: return _error("TARGET_NOT_FOUND", "Requested scene is not open")
	var node_path := String(step.get("parentPath", ".")) if operation == "create_node" else String(step.get("nodePath", ""))
	if not _valid_node_path(node_path): return _error("INVALID_REQUEST", "Invalid node path")
	var target: Node = root.get_node_or_null(NodePath(node_path))
	if target == null or (target != root and not root.is_ancestor_of(target)):
		return _error("TARGET_NOT_FOUND", "Requested node was not found")
	if operation == "create_node":
		var requested_class := String(step.get("className", ""))
		if not ClassDB.class_exists(requested_class) or not ClassDB.can_instantiate(requested_class) or not ClassDB.is_parent_class(requested_class, "Node"):
			return _error("INVALID_REQUEST", "Node class is not an instantiable engine Node class")
	if operation == "set_property":
		var property := String(step.get("property", ""))
		if property.is_empty() or not _has_property(target, property): return _error("TARGET_NOT_FOUND", "Requested property was not found")
		var decoded := VariantDecoder.decode(step.get("value"), _editor.get_resource_filesystem())
		if not decoded.ok: return decoded
		var current: Variant = target.get(property)
		if typeof(current) != typeof(decoded.value) and not (typeof(current) in [TYPE_INT, TYPE_FLOAT] and typeof(decoded.value) in [TYPE_INT, TYPE_FLOAT]):
			return _error("INVALID_REQUEST", "Property value type does not match the target")
	var revision := _node_revision(root, target)
	var identity := {"kind": _target_kind(operation), "path": scene_path + "::" + node_path, "revision": revision}
	return {"ok": true, "precondition": {"target": identity, "expectedRevision": revision, "expectedAbsent": false}, "change": {"operation": operation, "target": identity, "beforeRevision": revision, "afterRevision": null}}

func _validate_file_step(step: Dictionary) -> Dictionary:
	var operation := String(step.get("operation", ""))
	var path_key := "resourcePath" if "resource" in operation else "scenePath"
	var path := String(step.get(path_key, ""))
	var valid := _valid_resource_path(path) if path_key == "resourcePath" else _valid_scene_path(path)
	if not valid: return _error("INVALID_REQUEST", "Invalid project file path")
	if operation.begins_with("create_"):
		var requested_class := String(step.get("className", step.get("rootClassName", "")))
		var base := "Resource" if path_key == "resourcePath" else "Node"
		if not ClassDB.class_exists(requested_class) or not ClassDB.can_instantiate(requested_class) or not ClassDB.is_parent_class(requested_class, base):
			return _error("INVALID_REQUEST", "Requested class is not allowed for this project file")
	var exists := FileAccess.file_exists(path)
	if operation.begins_with("create_") and exists: return _error("CONFLICT", "Destination already exists")
	if not operation.begins_with("create_") and not exists: return _error("TARGET_NOT_FOUND", "Source project file was not found")
	var revision: Variant = _file_revision(path) if exists else null
	var identity := {"kind": "resource" if path_key == "resourcePath" else "scene", "path": path, "revision": revision}
	return {"ok": true, "precondition": {"target": identity, "expectedRevision": revision, "expectedAbsent": not exists}, "change": {"operation": operation, "target": identity, "beforeRevision": revision, "afterRevision": null}}

func _find_open_root(scene_path: String) -> Node:
	for root in _editor.get_open_scene_roots():
		if String(root.scene_file_path) == scene_path: return root
	return null

func _node_revision(root: Node, target: Node) -> String:
	var properties: Array[Dictionary] = []
	for property in target.get_property_list():
		if int(property.get("usage", 0)) & PROPERTY_USAGE_STORAGE == 0: continue
		var name := String(property.name)
		properties.append({"name": name, "value": "[redacted]" if VariantEncoder.is_secret_name(name) else VariantEncoder.encode_value(target.get(name))})
	properties.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return String(a.name) < String(b.name))
	return _sha256(CanonicalJson.encode(_tag_floats({"path": String(root.get_path_to(target)), "class": target.get_class(), "owner": String(root.get_path_to(target.owner)) if target.owner != null else "", "properties": properties})))

func _file_revision(path: String) -> String:
	return _sha256(FileAccess.get_file_as_bytes(path))

func _tag_floats(value: Variant) -> Variant:
	if typeof(value) == TYPE_FLOAT: return {"type": "Float", "value": str(value)}
	if typeof(value) == TYPE_ARRAY:
		return value.map(func(item: Variant) -> Variant: return _tag_floats(item))
	if typeof(value) == TYPE_DICTIONARY:
		var output := {}
		var keys: Array = value.keys(); keys.sort()
		for key in keys: output[String(key)] = _tag_floats(value[key])
		return output
	return value

func _sha256(value: Variant) -> String:
	var bytes: PackedByteArray = value.to_utf8_buffer() if typeof(value) == TYPE_STRING else value
	var context := HashingContext.new(); context.start(HashingContext.HASH_SHA256); context.update(bytes)
	return context.finish().hex_encode()

func _has_property(target: Object, property_name: String) -> bool:
	return target.get_property_list().any(func(property: Dictionary) -> bool: return String(property.name) == property_name)

func _target_kind(operation: String) -> String:
	if "property" in operation: return "property"
	if "metadata" in operation: return "metadata"
	if "group" in operation: return "group"
	if "signal" in operation: return "signal"
	if "owner" in operation: return "owner"
	return "node"

func _valid_node_path(path: String) -> bool:
	return not path.is_empty() and not path.begins_with("/") and ":" not in path and not _contains_nul(path) and ".." not in path.split("/")

func _valid_scene_path(path: String) -> bool:
	return path.begins_with("res://") and (path.ends_with(".tscn") or path.ends_with(".scn")) and ".." not in path.trim_prefix("res://").split("/") and not _contains_nul(path)

func _valid_resource_path(path: String) -> bool:
	return path.begins_with("res://") and (path.ends_with(".tres") or path.ends_with(".res")) and ".." not in path.trim_prefix("res://").split("/") and not _contains_nul(path)

func _contains_nul(value: String) -> bool:
	for index in value.length():
		if value.unicode_at(index) == 0: return true
	return false

func _error(code: String, message: String) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": false}
