@tool
class_name GodotMcpEditorMutationTransaction
extends RefCounted

const VariantDecoder = preload("res://addons/godot_mcp/mutation/editor_variant_decoder.gd")

var root: Node
var editor_filesystem: Variant
var failure := ""

func _init(scene_root: Node, filesystem: Variant) -> void:
	root = scene_root
	editor_filesystem = filesystem

func prepare(step_value: Dictionary) -> Dictionary:
	var step := step_value.duplicate(true)
	var operation := String(step.operation)
	var node: Node = root.get_node_or_null(NodePath(String(step.get("nodePath", "."))))
	if operation == "create_node":
		var parent: Node = root.get_node_or_null(NodePath(String(step.parentPath)))
		var created: Node = ClassDB.instantiate(String(step.className))
		created.name = String(step.name)
		step._node = created; step._parent = parent; step._index = parent.get_child_count()
	elif operation == "duplicate_node":
		var parent: Node = root.get_node_or_null(NodePath(String(step.parentPath)))
		var duplicate: Node = node.duplicate()
		duplicate.name = String(step.name)
		step._node = duplicate; step._parent = parent; step._index = parent.get_child_count()
	elif operation == "delete_node":
		step._node = node; step._parent = node.get_parent(); step._index = node.get_index()
	elif operation == "set_property":
		var decoded := VariantDecoder.decode(step.value, editor_filesystem)
		if not decoded.ok: return decoded
		step._node = node; step._before = node.get(String(step.property)); step._after = decoded.value
	elif operation in ["set_metadata", "remove_metadata"]:
		step._node = node; step._had_before = node.has_meta(String(step.key)); step._before = node.get_meta(String(step.key), null)
		if operation == "set_metadata":
			var decoded := VariantDecoder.decode(step.value, editor_filesystem)
			if not decoded.ok: return decoded
			step._after = decoded.value
	elif operation in ["add_group", "remove_group"]:
		step._node = node; step._before = node.is_in_group(String(step.group))
	elif operation == "rename_node":
		step._node = node; step._before = String(node.name); step._after = String(step.name)
	elif operation == "move_node":
		step._node = node; step._before = node.get_index(); step._after = int(step.index)
	elif operation == "reparent_node":
		step._node = node; step._before_parent = node.get_parent(); step._before = node.get_index()
		step._after_parent = root.get_node_or_null(NodePath(String(step.parentPath))); step._after = int(step.index)
	elif operation == "set_owner":
		step._node = node; step._before = node.owner
		step._after = null if step.ownerPath == null else root.get_node_or_null(NodePath(String(step.ownerPath)))
	elif operation in ["connect_signal", "disconnect_signal"]:
		var target: Node = root.get_node_or_null(NodePath(String(step.targetPath)))
		if target == null or not target.has_method(String(step.method)) or not node.has_signal(String(step.signal)):
			return _error("TARGET_NOT_FOUND", "Signal source, target, or method was not found")
		step._node = node; step._callable = Callable(target, String(step.method)); step._before = node.is_connected(String(step.signal), step._callable)
	else:
		return _error("INVALID_REQUEST", "Mutation operation is not implemented in the scene transaction")
	return {"ok": true, "step": step}

func apply_step(step: Dictionary, forward: bool) -> void:
	if not failure.is_empty(): return
	var operation := String(step.operation)
	var node: Node = step.get("_node")
	if not is_instance_valid(node): return _fail("Mutation node became invalid")
	match operation:
		"create_node", "duplicate_node":
			if forward:
				step._parent.add_child(node); step._parent.move_child(node, mini(int(step._index), step._parent.get_child_count() - 1)); node.owner = root
			else: step._parent.remove_child(node)
		"delete_node":
			if forward: step._parent.remove_child(node)
			else:
				step._parent.add_child(node); step._parent.move_child(node, mini(int(step._index), step._parent.get_child_count() - 1)); node.owner = root
		"set_property": node.set(String(step.property), step._after if forward else step._before)
		"set_metadata":
			if forward: node.set_meta(String(step.key), step._after)
			elif step._had_before: node.set_meta(String(step.key), step._before)
			else: node.remove_meta(String(step.key))
		"remove_metadata":
			if forward: node.remove_meta(String(step.key))
			elif step._had_before: node.set_meta(String(step.key), step._before)
		"add_group":
			if forward: node.add_to_group(String(step.group), bool(step.get("persistent", true)))
			elif not step._before: node.remove_from_group(String(step.group))
		"remove_group":
			if forward: node.remove_from_group(String(step.group))
			elif step._before: node.add_to_group(String(step.group), true)
		"rename_node": node.name = step._after if forward else step._before
		"move_node": node.get_parent().move_child(node, int(step._after if forward else step._before))
		"reparent_node":
			var parent: Node = step._after_parent if forward else step._before_parent
			node.reparent(parent); parent.move_child(node, mini(int(step._after if forward else step._before), parent.get_child_count() - 1))
		"set_owner": node.owner = step._after if forward else step._before
		"connect_signal":
			if forward and not node.is_connected(String(step.signal), step._callable): node.connect(String(step.signal), step._callable, int(step.get("flags", 0)))
			elif not forward and not step._before and node.is_connected(String(step.signal), step._callable): node.disconnect(String(step.signal), step._callable)
		"disconnect_signal":
			if forward and node.is_connected(String(step.signal), step._callable): node.disconnect(String(step.signal), step._callable)
			elif not forward and step._before and not node.is_connected(String(step.signal), step._callable): node.connect(String(step.signal), step._callable)

func _fail(message: String) -> void:
	if failure.is_empty(): failure = message

func _error(code: String, message: String) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": false}
