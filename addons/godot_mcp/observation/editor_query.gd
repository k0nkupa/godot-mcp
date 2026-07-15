@tool
class_name GodotMcpEditorQuery
extends RefCounted

const VariantEncoder = preload("res://addons/godot_mcp/observation/variant_encoder.gd")
const MAX_JSON_BYTES := 512 * 1024
const MAX_PROPERTIES := 128
const APPROVED_SETTING_PREFIXES := ["application/", "audio/", "display/", "input/", "navigation/", "physics/", "rendering/"]

var _editor: EditorInterface
var _logger: Logger

func _init(editor: EditorInterface, logger: Logger) -> void:
	_editor = editor
	_logger = logger

func execute(arguments: Dictionary) -> Dictionary:
	var operation := String(arguments.get("operation", ""))
	var data: Dictionary
	match operation:
		"editor_state": data = _editor_state()
		"scene_tree": data = _scene_tree(arguments)
		"node": data = _node(arguments)
		"resources": data = _resources(arguments)
		"project_settings": data = _project_settings(arguments)
		"diagnostics": data = _diagnostics(arguments)
		_: return _error("INVALID_REQUEST", "Unknown editor query operation")
	if data.has("_error"):
		return data._error
	data.operation = operation
	if JSON.stringify(data).to_utf8_buffer().size() > MAX_JSON_BYTES:
		return _error("PAYLOAD_TOO_LARGE", "Editor query result exceeds 512 KiB")
	return {"ok": true, "data": data}

func _editor_state() -> Dictionary:
	var root := _editor.get_edited_scene_root()
	var selected_nodes: Array[String] = []
	for node in _editor.get_selection().get_selected_nodes():
		selected_nodes.append(String(node.get_path()))
	var filesystem := _editor.get_resource_filesystem()
	return {
		"editedScene": String(root.scene_file_path) if root != null else "",
		"openScenes": Array(_editor.get_open_scenes()),
		"unsavedScenes": Array(_editor.get_unsaved_scenes()),
		"selectedNodes": selected_nodes,
		"selectedPaths": Array(_editor.get_selected_paths()),
		"filesystem": {"scanning": filesystem.is_scanning(), "importing": filesystem.is_importing(), "progress": VariantEncoder.encode_value(filesystem.get_scanning_progress())},
		"truncated": false,
	}

func _scene_tree(arguments: Dictionary) -> Dictionary:
	var root := _find_open_root(String(arguments.get("scenePath", "")))
	if root == null:
		return {"_error": _error("TARGET_NOT_FOUND", "Requested scene is not open")}
	var max_depth := clampi(int(arguments.get("maxDepth", 12)), 0, 32)
	var max_nodes := clampi(int(arguments.get("maxNodes", 500)), 1, 1000)
	var nodes: Array[Dictionary] = []
	var stack: Array[Dictionary] = [{"node": root, "depth": 0}]
	var truncated := false
	while not stack.is_empty():
		var entry: Dictionary = stack.pop_back()
		var node: Node = entry.node
		var depth: int = entry.depth
		if nodes.size() >= max_nodes:
			truncated = true
			break
		nodes.append(_node_summary(root, node))
		if depth >= max_depth:
			truncated = truncated or node.get_child_count() > 0
			continue
		for index in range(node.get_child_count() - 1, -1, -1):
			stack.append({"node": node.get_child(index), "depth": depth + 1})
	return {"scenePath": String(root.scene_file_path), "nodes": nodes, "truncated": truncated}

func _node(arguments: Dictionary) -> Dictionary:
	var root := _find_open_root(String(arguments.get("scenePath", "")))
	if root == null:
		return {"_error": _error("TARGET_NOT_FOUND", "Requested scene is not open")}
	var target := root.get_node_or_null(NodePath(String(arguments.get("nodePath", ""))))
	if target == null:
		return {"_error": _error("TARGET_NOT_FOUND", "Requested node was not found")}
	var data := _node_summary(root, target)
	data.signals = VariantEncoder.encode_value(target.get_signal_list())
	data.properties = []
	if bool(arguments.get("includeProperties", true)):
		for property in target.get_property_list():
			if data.properties.size() >= MAX_PROPERTIES:
				data.propertiesTruncated = true
				break
			var usage := int(property.get("usage", 0))
			if usage & (PROPERTY_USAGE_STORAGE | PROPERTY_USAGE_EDITOR) == 0:
				continue
			var name := String(property.name)
			data.properties.append({"name": name, "type": int(property.type), "value": VariantEncoder.encode_value(target.get(name))})
	return data

func _resources(arguments: Dictionary) -> Dictionary:
	var prefix := String(arguments.get("prefix", "res://"))
	var cursor := String(arguments.get("cursor", ""))
	var limit := clampi(int(arguments.get("limit", 200)), 1, 2000)
	var requested_kinds: Array = arguments.get("kinds", [])
	var records: Array[Dictionary] = []
	_collect_resources(_editor.get_resource_filesystem().get_filesystem(), records)
	records.sort_custom(func(left: Dictionary, right: Dictionary) -> bool: return String(left.path) < String(right.path))
	var page: Array[Dictionary] = []
	for record in records:
		if not String(record.path).begins_with(prefix) or (not cursor.is_empty() and String(record.path) <= cursor):
			continue
		if not requested_kinds.is_empty() and record.kind not in requested_kinds:
			continue
		if page.size() >= limit:
			break
		page.append(record)
	var has_more := page.size() == limit and records.any(func(record: Dictionary) -> bool: return String(record.path) > String(page[-1].path) and String(record.path).begins_with(prefix))
	return {"resources": page, "nextCursor": String(page[-1].path) if has_more else "", "truncated": has_more}

func _project_settings(arguments: Dictionary) -> Dictionary:
	var prefix := String(arguments.get("prefix", ""))
	if prefix not in APPROVED_SETTING_PREFIXES:
		return {"_error": _error("INVALID_REQUEST", "Project setting prefix is not approved")}
	var cursor := String(arguments.get("cursor", ""))
	var limit := clampi(int(arguments.get("limit", 200)), 1, 2000)
	var records: Array[Dictionary] = []
	for property in ProjectSettings.get_property_list():
		var name := String(property.name)
		if not name.begins_with(prefix) or (not cursor.is_empty() and name <= cursor) or VariantEncoder._is_secret_name(name):
			continue
		records.append({"name": name, "type": int(property.type), "value": VariantEncoder.encode_value(ProjectSettings.get_setting(name)), "changedFromDefault": ProjectSettings.get_setting(name) != ProjectSettings.property_get_revert(name) if ProjectSettings.property_can_revert(name) else false})
	records.sort_custom(func(left: Dictionary, right: Dictionary) -> bool: return String(left.name) < String(right.name))
	var has_more := records.size() > limit
	var page := records.slice(0, limit)
	return {"settings": page, "nextCursor": String(page[-1].name) if has_more and not page.is_empty() else "", "truncated": has_more}

func _diagnostics(arguments: Dictionary) -> Dictionary:
	var records: Array[Dictionary] = _logger.read_after(int(arguments.get("afterSequence", 0)), Array(arguments.get("levels", ["log", "warning", "error", "script", "shader"])), clampi(int(arguments.get("limit", 100)), 1, 500))
	return {"records": records, "truncated": records.size() >= int(arguments.get("limit", 100))}

func _find_open_root(scene_path: String) -> Node:
	var roots := _editor.get_open_scene_roots()
	if scene_path.is_empty():
		return _editor.get_edited_scene_root()
	for root in roots:
		if String(root.scene_file_path) == scene_path:
			return root
	return null

func _node_summary(root: Node, node: Node) -> Dictionary:
	var script: Script = node.get_script()
	return {
		"nodePath": String(root.get_path_to(node)), "name": String(node.name), "className": node.get_class(),
		"ownerPath": String(root.get_path_to(node.owner)) if node.owner != null else "", "childCount": node.get_child_count(),
		"groups": Array(node.get_groups()),
		"script": null if script == null else {"className": script.get_class(), "path": script.resource_path, "uid": ResourceUID.path_to_uid(script.resource_path)},
	}

func _collect_resources(directory: EditorFileSystemDirectory, records: Array[Dictionary]) -> void:
	for index in directory.get_file_count():
		var path := directory.get_file_path(index)
		var type := String(directory.get_file_type(index))
		records.append({"path": path, "type": type, "uid": ResourceUID.path_to_uid(path), "importValid": directory.get_file_import_is_valid(index), "scriptClass": directory.get_file_script_class_name(index), "kind": _resource_kind(path, type)})
	for index in directory.get_subdir_count():
		_collect_resources(directory.get_subdir(index), records)

func _resource_kind(path: String, type: String) -> String:
	var extension := path.get_extension().to_lower()
	if extension == "tscn" or extension == "scn": return "scene"
	if extension in ["gd", "cs"]: return "script"
	if extension in ["gdshader", "shader"]: return "shader"
	if type.contains("Texture"): return "texture"
	if type.contains("Audio"): return "audio"
	if extension in ["tres", "res"]: return "resource"
	return "other"

func _error(code: String, message: String) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": false}
