class_name GodotMcpRuntimeControl
extends RefCounted

const VariantEncoder = preload("res://addons/godot_mcp/observation/variant_encoder.gd")
const RuntimeFrameClock = preload("res://addons/godot_mcp/runtime/runtime_frame_clock.gd")

var _root: Node
var _query: RefCounted
var _logger: Logger
var _frame_clock: RefCounted

func _init(root: Node, query: RefCounted, logger: Logger, frame_clock: RefCounted = null) -> void:
	_root = root
	_query = query
	_logger = logger
	_frame_clock = frame_clock if frame_clock != null else RuntimeFrameClock.new(root)

func execute(operation: String, arguments: Dictionary, deadline_unix_ms: int) -> Dictionary:
	match operation:
		"pause":
			_root.get_tree().paused = true
			return {"ok": true, "data": _frame_state()}
		"resume":
			_root.get_tree().paused = false
			return {"ok": true, "data": _frame_state()}
		"step":
			return await _frame_clock.advance_paused(clampi(int(arguments.get("frames", 1)), 1, 120), deadline_unix_ms)
		"wait":
			return await _wait(arguments.get("condition", {}), mini(deadline_unix_ms, _now_ms() + clampi(int(arguments.get("timeoutMs", 10000)), 1, 30000)))
		_: return _error("INVALID_REQUEST", "Runtime control operation is not allowed")

func _wait(condition: Variant, deadline_unix_ms: int) -> Dictionary:
	if typeof(condition) != TYPE_DICTIONARY:
		return _error("INVALID_REQUEST", "Runtime wait condition is invalid")
	if not is_instance_valid(_root):
		return _error("TARGET_NOT_FOUND", "Runtime scene changed")
	var tree := _root.get_tree()
	if String(condition.get("type", "")) == "signal_emitted":
		return await _wait_signal(condition, deadline_unix_ms)
	if String(condition.get("type", "")) in ["property_equals", "property_matches"]:
		var node: Node = _query.resolve_node(String(condition.get("nodePath", ".")))
		var property := String(condition.get("property", ""))
		if VariantEncoder.is_secret_name(property):
			return _error("INVALID_REQUEST", "Runtime wait property is redacted")
		if node == null or not _has_property(node, property):
			return _error("TARGET_NOT_FOUND", "Runtime wait property was not found")
	var property_regex: RegEx
	if String(condition.get("type", "")) == "property_matches":
		if not safe_property_pattern(String(condition.get("pattern", ""))):
			return _error("INVALID_REQUEST", "Runtime wait pattern uses unsupported regex features")
		property_regex = RegEx.new()
		if property_regex.compile(String(condition.get("pattern", ""))) != OK:
			return _error("INVALID_REQUEST", "Runtime wait pattern is invalid")
	var started_process_frame := Engine.get_process_frames()
	while _now_ms() < deadline_unix_ms:
		var observed := _condition_state(condition, started_process_frame, property_regex)
		if bool(observed.get("targetMissing", false)):
			return _error("TARGET_NOT_FOUND", "Runtime wait property was not found")
		if bool(observed.get("invalidValue", false)):
			return _error("INVALID_REQUEST", "Runtime property pattern requires a primitive value")
		if bool(observed.get("satisfied", false)):
			return {"ok": true, "data": observed}
		await tree.process_frame
	return _error("TIMEOUT", "Runtime wait condition timed out", true)

func _wait_signal(condition: Dictionary, deadline_unix_ms: int) -> Dictionary:
	if not is_instance_valid(_root):
		return _error("TARGET_NOT_FOUND", "Runtime scene changed")
	var tree := _root.get_tree()
	var node: Node = _query.resolve_node(String(condition.get("nodePath", ".")))
	var signal_name := StringName(String(condition.get("signal", "")))
	if node == null or not node.has_signal(signal_name):
		return _error("TARGET_NOT_FOUND", "Runtime wait signal was not found")
	var argument_count := -1
	for signal_info in node.get_signal_list():
		if String(signal_info.name) == String(signal_name):
			argument_count = Array(signal_info.get("args", [])).size()
			break
	if argument_count < 0 or argument_count > 8:
		return _error("INVALID_REQUEST", "Runtime wait signal has an unsupported argument count")
	var observed := [false]
	var callback: Callable
	match argument_count:
		0: callback = func() -> void: observed[0] = true
		1: callback = func(_a: Variant) -> void: observed[0] = true
		2: callback = func(_a: Variant, _b: Variant) -> void: observed[0] = true
		3: callback = func(_a: Variant, _b: Variant, _c: Variant) -> void: observed[0] = true
		4: callback = func(_a: Variant, _b: Variant, _c: Variant, _d: Variant) -> void: observed[0] = true
		5: callback = func(_a: Variant, _b: Variant, _c: Variant, _d: Variant, _e: Variant) -> void: observed[0] = true
		6: callback = func(_a: Variant, _b: Variant, _c: Variant, _d: Variant, _e: Variant, _f: Variant) -> void: observed[0] = true
		7: callback = func(_a: Variant, _b: Variant, _c: Variant, _d: Variant, _e: Variant, _f: Variant, _g: Variant) -> void: observed[0] = true
		8: callback = func(_a: Variant, _b: Variant, _c: Variant, _d: Variant, _e: Variant, _f: Variant, _g: Variant, _h: Variant) -> void: observed[0] = true
	node.connect(signal_name, callback, CONNECT_ONE_SHOT)
	while not observed[0] and _now_ms() < deadline_unix_ms:
		await tree.process_frame
		if not is_instance_valid(node):
			break
	if is_instance_valid(node) and node.is_connected(signal_name, callback):
		node.disconnect(signal_name, callback)
	if observed[0]:
		return {"ok": true, "data": {"satisfied": true, "signal": String(signal_name)}}
	if not is_instance_valid(node):
		return _error("TARGET_NOT_FOUND", "Runtime wait signal target was freed")
	return _error("TIMEOUT", "Runtime wait condition timed out", true)

func _condition_state(condition: Dictionary, started_process_frame: int, property_regex: RegEx = null) -> Dictionary:
	var kind := String(condition.get("type", ""))
	var node: Node = _query.resolve_node(String(condition.get("nodePath", ".")))
	match kind:
		"node_exists": return {"satisfied": node != null}
		"node_missing": return {"satisfied": node == null}
		"property_equals":
			var property := String(condition.get("property", ""))
			if node == null or not _has_property(node, property):
				return {"satisfied": false, "targetMissing": true}
			return {"satisfied": node.get(property) == condition.get("value")}
		"property_matches":
			var property := String(condition.get("property", ""))
			if node == null or not _has_property(node, property):
				return {"satisfied": false, "targetMissing": true}
			var bounded := bounded_primitive_subject(node.get(property))
			if not bool(bounded.valid):
				return {"satisfied": false, "invalidValue": true}
			return {"satisfied": property_regex != null and property_regex.search(String(bounded.subject)) != null}
		"log_matches":
			var levels: Array = [String(condition.level)] if condition.has("level") else ["log", "warning", "error", "script", "shader"]
			var records: Array[Dictionary] = _logger.read_after(0, levels, 500)
			for record in records:
				if String(condition.get("pattern", "")) in String(record.message):
					return {"satisfied": true, "record": record}
			return {"satisfied": false}
		"frames_elapsed":
			var elapsed := Engine.get_process_frames() - started_process_frame
			return {"satisfied": elapsed >= int(condition.get("frames", 1)), "framesElapsed": elapsed}
		_: return {"satisfied": false}

func _frame_state() -> Dictionary:
	if not is_instance_valid(_root):
		return {}
	return {"paused": _root.get_tree().paused, "processFrames": Engine.get_process_frames(), "physicsFrames": Engine.get_physics_frames()}

static func _now_ms() -> int:
	return int(Time.get_unix_time_from_system() * 1000.0)

static func _has_property(node: Node, property: String) -> bool:
	for property_info in node.get_property_list():
		if String(property_info.get("name", "")) == property:
			return true
	return false

static func safe_property_pattern(pattern: String) -> bool:
	if pattern.is_empty() or pattern.length() > 64:
		return false
	for forbidden in ["\\", "+", "{", "}", "(", ")", "|", "[", "]"]:
		if forbidden in pattern:
			return false
	return pattern.count("*") <= 1 and "**" not in pattern and "*?" not in pattern and "?*" not in pattern

static func bounded_primitive_subject(value: Variant) -> Dictionary:
	if typeof(value) not in [TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING, TYPE_STRING_NAME]:
		return {"valid": false, "subject": ""}
	return {"valid": true, "subject": String(value).left(4096)}

static func _error(code: String, message: String, retryable := false) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": retryable}
