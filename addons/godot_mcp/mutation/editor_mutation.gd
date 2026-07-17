@tool
class_name GodotMcpEditorMutation
extends RefCounted

const CanonicalJson = preload("res://addons/godot_mcp/bridge/canonical_json.gd")
const VariantDecoder = preload("res://addons/godot_mcp/mutation/editor_variant_decoder.gd")
const VariantEncoder = preload("res://addons/godot_mcp/observation/variant_encoder.gd")
const MutationTransaction = preload("res://addons/godot_mcp/mutation/editor_mutation_transaction.gd")
const ProjectFileTransaction = preload("res://addons/godot_mcp/mutation/project_file_transaction.gd")
const AuthoringPlanner = preload("res://addons/godot_mcp/authoring/authoring_planner.gd")
const MAX_STEPS := 32
const FILE_OPERATIONS := ["create_scene", "duplicate_scene", "move_scene", "delete_scene", "create_resource", "duplicate_resource", "move_resource", "delete_resource"]

var _editor: Variant
var _undo_redo: Variant
var _project_root: String
var _session_generation: Callable
var _actions := {}
var _authoring: RefCounted

func _init(editor: Variant, undo_redo: Variant, project_root: String, session_generation: Callable) -> void:
	_editor = editor
	_undo_redo = undo_redo
	_project_root = project_root
	_session_generation = session_generation
	_authoring = AuthoringPlanner.new(editor, project_root)

func execute(arguments: Dictionary) -> Dictionary:
	match String(arguments.get("operation", "")):
		"preview": return _preview(arguments)
		"apply": return _apply(arguments)
		"undo": return _change_action(arguments, false)
		"redo": return _change_action(arguments, true)
	return _error("INVALID_REQUEST", "Unknown editor mutation operation")

func clear() -> void:
	_editor = null
	_undo_redo = null
	_actions.clear()
	_authoring = null

func _apply(arguments: Dictionary) -> Dictionary:
	var preview := _preview({"operation": "preview", "steps": arguments.get("steps", [])})
	if not preview.ok: return preview
	if String(arguments.get("expectedPlanDigest", "")) != String(preview.data.planDigest):
		return _error("CONFLICT", "Editor targets changed after preview")
	if _undo_redo == null: return _error("GODOT_RUNTIME_ERROR", "Editor Undo/Redo manager is unavailable")
	var action_id := _uuid()
	if preview.data.history.kind == "global":
		return _apply_files(arguments, preview.data, action_id)
	var root := _find_open_root(String(preview.data.history.scenePath))
	var transaction := MutationTransaction.new(root, _editor.get_resource_filesystem())
	var prepared: Array[Dictionary] = []
	for step in arguments.steps:
		var result: Dictionary
		if _authoring.handles(String(step.get("operation", ""))):
			var authoring_result: Dictionary = _authoring.prepare_step(step, root, action_id)
			result = transaction.prepare_authoring(authoring_result) if authoring_result.ok else authoring_result
		else:
			result = transaction.prepare(step)
		if not result.ok: return result
		prepared.append(result.step)
	if _undo_redo is EditorUndoRedoManager:
		_undo_redo.create_action("Godot MCP %s" % action_id, UndoRedo.MERGE_DISABLE, root, true, true)
		for step in prepared: _undo_redo.add_do_method(transaction, "apply_step", step, true)
		for index in range(prepared.size() - 1, -1, -1): _undo_redo.add_undo_method(transaction, "apply_step", prepared[index], false)
		_undo_redo.commit_action()
	else:
		_undo_redo.create_action("Godot MCP %s" % action_id, UndoRedo.MERGE_DISABLE, true)
		for step in prepared: _undo_redo.add_do_method(Callable(transaction, "apply_step").bind(step, true))
		for index in range(prepared.size() - 1, -1, -1): _undo_redo.add_undo_method(Callable(transaction, "apply_step").bind(prepared[index], false))
		_undo_redo.commit_action()
	if not transaction.failure.is_empty():
		_history_for(root).undo()
		return {"ok": false, "code": "ROLLBACK_FAILED" if not transaction.failure.is_empty() else "GODOT_RUNTIME_ERROR", "message": transaction.failure, "retryable": false, "partialEffects": false, "rollback": "succeeded"}
	if _editor.has_method("save_scene") and _editor.save_scene() != OK:
		_history_for(root).undo()
		return _error("GODOT_RUNTIME_ERROR", "Failed to save the mutated scene")
	_actions[action_id] = {"history": _history_for(root), "transaction": transaction, "state": "applied", "preview": preview.data}
	return _action_result("applied", action_id, preview.data)

func _apply_files(arguments: Dictionary, preview: Dictionary, action_id: String) -> Dictionary:
	var transaction := ProjectFileTransaction.new(_project_root, _editor.get_resource_filesystem(), action_id)
	var phase_five_steps: Array = []
	for step in arguments.steps:
		if _authoring.handles(String(step.get("operation", ""))): continue
		phase_five_steps.append(step)
	var prepared_result: Dictionary = transaction.prepare_steps(phase_five_steps)
	if not prepared_result.ok: return prepared_result
	var authoring_steps: Array = []
	for step in arguments.steps:
		if _authoring.handles(String(step.get("operation", ""))): authoring_steps.append(step)
	var authoring_result: Dictionary = _authoring.prepare_global_steps(authoring_steps, action_id)
	if not authoring_result.ok: return authoring_result
	for prepared_authoring in authoring_result.prepared:
		prepared_result = transaction.prepare_external(prepared_authoring)
		if not prepared_result.ok: return prepared_result
	var history: UndoRedo
	if _undo_redo is EditorUndoRedoManager:
		_undo_redo.create_action("Godot MCP %s" % action_id, UndoRedo.MERGE_DISABLE, null, true, false)
		_undo_redo.add_do_method(transaction, "apply_all", true)
		_undo_redo.add_undo_method(transaction, "apply_all", false)
		_undo_redo.commit_action()
		history = _undo_redo.get_history_undo_redo(EditorUndoRedoManager.GLOBAL_HISTORY)
	else:
		_undo_redo.create_action("Godot MCP %s" % action_id, UndoRedo.MERGE_DISABLE, true)
		_undo_redo.add_do_method(Callable(transaction, "apply_all").bind(true))
		_undo_redo.add_undo_method(Callable(transaction, "apply_all").bind(false))
		_undo_redo.commit_action()
		history = _undo_redo
	if not transaction.failure.is_empty():
		return {"ok": false, "code": "ROLLBACK_FAILED" if transaction.partial_effects else "GODOT_RUNTIME_ERROR", "message": transaction.failure, "retryable": false, "partialEffects": transaction.partial_effects, "rollback": transaction.rollback}
	_actions[action_id] = {"history": history, "transaction": transaction, "state": "applied", "preview": preview}
	return _action_result("applied", action_id, preview)

func _change_action(arguments: Dictionary, redo: bool) -> Dictionary:
	var action_id := String(arguments.get("actionId", ""))
	if not _actions.has(action_id): return _error("CONFLICT", "Requested MCP action is not available in this session")
	var record: Dictionary = _actions[action_id]
	if (redo and record.state != "undone") or (not redo and record.state != "applied"):
		return _error("CONFLICT", "Requested MCP action is not at the expected undo state")
	var history: UndoRedo = record.history
	var changed: bool = history.redo() if redo else history.undo()
	if not changed: return _error("CONFLICT", "Editor Undo/Redo history changed outside MCP")
	record.state = "applied" if redo else "undone"
	_actions[action_id] = record
	if record.preview.history.kind == "scene" and _editor.has_method("save_scene") and _editor.save_scene() != OK:
		return _error("GODOT_RUNTIME_ERROR", "Failed to save the scene after Undo/Redo")
	return _action_result("redone" if redo else "undone", action_id, record.preview)

func _history_for(root: Node) -> UndoRedo:
	if _undo_redo is EditorUndoRedoManager:
		return _undo_redo.get_history_undo_redo(_undo_redo.get_object_history_id(root))
	return _undo_redo

func _action_result(state: String, action_id: String, preview: Dictionary) -> Dictionary:
	return {"ok": true, "data": {"state": state, "actionId": action_id, "planDigest": preview.planDigest, "history": preview.history, "preconditions": preview.preconditions, "changes": preview.changes, "warnings": [], "audit": {"targetIdentities": preview.audit.targetIdentities, "preconditions": preview.preconditions, "idempotencyKeySha256": null, "partialEffects": false, "rollback": "not_needed"}}}

func _uuid() -> String:
	var bytes := Crypto.new().generate_random_bytes(16)
	bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80
	var value := bytes.hex_encode()
	return "%s-%s-%s-%s-%s" % [value.substr(0, 8), value.substr(8, 4), value.substr(12, 4), value.substr(16, 4), value.substr(20, 12)]

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
		var authoring_step: bool = _authoring.handles(operation)
		var authoring_validation: Dictionary = _authoring.preview_step(step) if authoring_step else {}
		if authoring_step and not authoring_validation.ok: return authoring_validation
		var file_step: bool = operation in FILE_OPERATIONS or (authoring_step and String(authoring_validation.history) == "global")
		var requested_history := "global" if file_step else "scene"
		if history_kind.is_empty(): history_kind = requested_history
		if history_kind != requested_history:
			return _error("CONFLICT", "One mutation batch cannot mix scene and global undo histories")
		var validated := authoring_validation if authoring_step else (_validate_file_step(step) if file_step else _validate_node_step(step))
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
	if not _allowed_project_file_path(path): return _error("INVALID_REQUEST", "Project file path is protected")
	var destination := String(step.get("destinationPath", ""))
	if not destination.is_empty():
		var destination_valid := _valid_resource_path(destination) if path_key == "resourcePath" else _valid_scene_path(destination)
		if not destination_valid or not _allowed_project_file_path(destination): return _error("INVALID_REQUEST", "Invalid destination project file path")
		if FileAccess.file_exists(destination): return _error("CONFLICT", "Destination already exists")
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
	if bytes.is_empty(): return "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
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

func _allowed_project_file_path(path: String) -> bool:
	var relative := path.trim_prefix("res://")
	var first := relative.get_slice("/", 0)
	if first in ["addons", ".git", ".godot"]: return false
	var lowered := path.to_lower()
	return not ("/.env" in lowered or "credential" in lowered or "secret" in lowered)

func _contains_nul(value: String) -> bool:
	for index in value.length():
		if value.unicode_at(index) == 0: return true
	return false

func _error(code: String, message: String) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": false}
