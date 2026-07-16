class_name GodotMcpRuntimeControl
extends RefCounted

var _root: Node
var _query: RefCounted
var _logger: Logger

func _init(root: Node, query: RefCounted, logger: Logger) -> void:
	_root = root
	_query = query
	_logger = logger

func execute(operation: String, arguments: Dictionary, deadline_unix_ms: int) -> Dictionary:
	match operation:
		"pause":
			_root.get_tree().paused = true
			return {"ok": true, "data": _frame_state()}
		"resume":
			_root.get_tree().paused = false
			return {"ok": true, "data": _frame_state()}
		"step":
			return await _step(clampi(int(arguments.get("frames", 1)), 1, 120))
		"wait":
			return await _wait(arguments.get("condition", {}), mini(deadline_unix_ms, _now_ms() + clampi(int(arguments.get("timeoutMs", 10000)), 1, 30000)))
		_: return _error("INVALID_REQUEST", "Runtime control operation is not allowed")

func _step(frames: int) -> Dictionary:
	if not _root.get_tree().paused:
		return _error("PRECONDITION_FAILED", "Runtime must be paused before frame stepping")
	for _frame in frames:
		_root.get_tree().paused = false
		await _root.get_tree().process_frame
		await RenderingServer.frame_post_draw
		_root.get_tree().paused = true
	return {"ok": true, "data": _frame_state()}

func _wait(condition: Variant, deadline_unix_ms: int) -> Dictionary:
	if typeof(condition) != TYPE_DICTIONARY:
		return _error("INVALID_REQUEST", "Runtime wait condition is invalid")
	if String(condition.get("type", "")) == "signal_emitted":
		return await _wait_signal(condition, deadline_unix_ms)
	if String(condition.get("type", "")) in ["property_equals", "property_matches"]:
		var node: Node = _query.resolve_node(String(condition.get("nodePath", ".")))
		var property := String(condition.get("property", ""))
		if node == null or not _has_property(node, property):
			return _error("TARGET_NOT_FOUND", "Runtime wait property was not found")
	var property_regex: RegEx
	if String(condition.get("type", "")) == "property_matches":
		property_regex = RegEx.new()
		if property_regex.compile(String(condition.get("pattern", ""))) != OK:
			return _error("INVALID_REQUEST", "Runtime wait pattern is invalid")
	var started_process_frame := Engine.get_process_frames()
	while _now_ms() < deadline_unix_ms:
		var observed := _condition_state(condition, started_process_frame, property_regex)
		if bool(observed.get("satisfied", false)):
			return {"ok": true, "data": observed}
		await _root.get_tree().process_frame
	return _error("TIMEOUT", "Runtime wait condition timed out", true)

func _wait_signal(condition: Dictionary, deadline_unix_ms: int) -> Dictionary:
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
		await _root.get_tree().process_frame
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
			return {"satisfied": node != null and node.get(String(condition.get("property", ""))) == condition.get("value")}
		"property_matches":
			if node == null:
				return {"satisfied": false}
			return {"satisfied": property_regex != null and property_regex.search(str(node.get(String(condition.get("property", ""))))) != null}
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
	return {"paused": _root.get_tree().paused, "processFrames": Engine.get_process_frames(), "physicsFrames": Engine.get_physics_frames()}

static func _now_ms() -> int:
	return int(Time.get_unix_time_from_system() * 1000.0)

static func _has_property(node: Node, property: String) -> bool:
	for property_info in node.get_property_list():
		if String(property_info.get("name", "")) == property:
			return true
	return false

static func _error(code: String, message: String, retryable := false) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": retryable}
