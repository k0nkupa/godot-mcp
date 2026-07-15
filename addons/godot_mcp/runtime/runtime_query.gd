class_name GodotMcpRuntimeQuery
extends RefCounted

const VariantEncoder = preload("res://addons/godot_mcp/observation/variant_encoder.gd")
const MAX_JSON_BYTES := 512 * 1024
const MAX_PROPERTIES := 128
const MAX_SIGNALS := 128

var _root: Node
var _logger: Logger

func _init(root: Node, logger: Logger) -> void:
	_root = root
	_logger = logger

func execute(operation: String, arguments: Dictionary) -> Dictionary:
	var data: Dictionary
	match operation:
		"status": data = {"running": true, "paused": _root.get_tree().paused, "processFrames": Engine.get_process_frames(), "physicsFrames": Engine.get_physics_frames()}
		"tree": data = _tree(arguments)
		"node": data = _node(arguments)
		"logs": data = _logs(arguments)
		_: return _error("INVALID_REQUEST", "Runtime query operation is not allowed")
	if data.has("_error"):
		return data._error
	if JSON.stringify(data).to_utf8_buffer().size() > MAX_JSON_BYTES:
		return _error("PAYLOAD_TOO_LARGE", "Runtime query result exceeds 512 KiB")
	return {"ok": true, "data": data}

func resolve_node(path: String) -> Node:
	if not valid_node_path(path):
		return null
	if path == ".":
		return _root
	var target := _root.get_node_or_null(NodePath(path))
	if target == null or (target != _root and not _root.is_ancestor_of(target)):
		return null
	return target

func _tree(arguments: Dictionary) -> Dictionary:
	var requested_root := resolve_node(String(arguments.get("root", ".")))
	if requested_root == null:
		return {"_error": _error("TARGET_NOT_FOUND", "Runtime tree root was not found")}
	var max_depth := clampi(int(arguments.get("maxDepth", 12)), 0, 32)
	var max_nodes := clampi(int(arguments.get("maxNodes", 500)), 1, 1000)
	var nodes: Array[Dictionary] = []
	var stack: Array[Dictionary] = [{"node": requested_root, "depth": 0}]
	var truncated := false
	while not stack.is_empty():
		var entry: Dictionary = stack.pop_back()
		var node: Node = entry.node
		var depth: int = entry.depth
		if nodes.size() >= max_nodes:
			truncated = true
			break
		nodes.append(_summary(node))
		if depth >= max_depth:
			truncated = truncated or node.get_child_count() > 0
			continue
		for index in range(node.get_child_count() - 1, -1, -1):
			stack.append({"node": node.get_child(index), "depth": depth + 1})
	return {"nodes": nodes, "truncated": truncated}

func _node(arguments: Dictionary) -> Dictionary:
	var target := resolve_node(String(arguments.get("nodePath", "")))
	if target == null:
		return {"_error": _error("TARGET_NOT_FOUND", "Runtime node was not found")}
	var data := _summary(target)
	data.properties = []
	data.signals = []
	if bool(arguments.get("includeProperties", true)):
		for property in target.get_property_list():
			if data.properties.size() >= MAX_PROPERTIES:
				data.propertiesTruncated = true
				break
			var usage := int(property.get("usage", 0))
			if usage & (PROPERTY_USAGE_STORAGE | PROPERTY_USAGE_EDITOR) == 0:
				continue
			var name := String(property.name)
			data.properties.append({"name": name, "type": int(property.type), "value": "[redacted]" if VariantEncoder.is_secret_name(name) else VariantEncoder.encode_value(target.get(name))})
	if bool(arguments.get("includeSignals", true)):
		for signal_info in target.get_signal_list().slice(0, MAX_SIGNALS):
			data.signals.append(VariantEncoder.encode_value(signal_info))
		data.signalsTruncated = target.get_signal_list().size() > MAX_SIGNALS
	return data

func _logs(arguments: Dictionary) -> Dictionary:
	var records: Array[Dictionary] = _logger.read_after(
		int(arguments.get("afterSequence", 0)),
		Array(arguments.get("levels", ["log", "warning", "error", "script", "shader"])),
		clampi(int(arguments.get("limit", 100)), 1, 500),
	)
	return {"records": records, "truncated": records.size() >= int(arguments.get("limit", 100))}

func _summary(node: Node) -> Dictionary:
	var script: Script = node.get_script()
	return {
		"nodePath": String(_root.get_path_to(node)),
		"name": String(node.name),
		"className": node.get_class(),
		"childCount": node.get_child_count(),
		"groups": Array(node.get_groups()),
		"script": null if script == null else {"className": script.get_class(), "path": script.resource_path},
	}

static func valid_node_path(path: String) -> bool:
	return not path.is_empty() and not path.begins_with("/") and ":" not in path and ".." not in path.split("/")

static func _error(code: String, message: String, retryable := false) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": retryable}
