class_name GodotMcpRuntimeDebugCapture
extends RefCounted

const VariantEncoder = preload("res://addons/godot_mcp/observation/variant_encoder.gd")
const MAX_FRAMES := 64
const MAX_VARIABLES := 2048
const MAX_TEXT_BYTES := 4096

var _frame_scopes: Array[Dictionary] = []
var _frames: Array[Dictionary] = []
var _globals: Array[Dictionary] = []
var _globals_truncated := false
var _references: Dictionary = {}
var _next_reference := 1

func stack(offset: int, limit: int) -> Dictionary:
	if not _frames.is_empty():
		return _stack_page(offset, limit)
	_clear_snapshot()
	var backtrace: ScriptBacktrace
	var best_score := 0
	for candidate: ScriptBacktrace in Engine.capture_script_backtraces(true):
		if candidate.get_language_name() != "GDScript" or candidate.is_empty():
			continue
		var sources: Array[String] = []
		for frame_index in candidate.get_frame_count():
			sources.append(candidate.get_frame_file(frame_index))
		var score := game_frame_score(sources)
		if score > best_score:
			backtrace = candidate
			best_score = score
	if backtrace == null:
		return _error("PRECONDITION_FAILED", "No stopped GDScript backtrace is available")
	var captured_variables := 0
	for source_frame_index in backtrace.get_frame_count():
		var source_path := backtrace.get_frame_file(source_frame_index)
		if source_path.to_lower().begins_with("res://addons/godot_mcp/"):
			continue
		var frame_index := _frames.size()
		if frame_index >= MAX_FRAMES:
			break
		var locals: Array[Dictionary] = []
		var members: Array[Dictionary] = []
		var source_local_count := backtrace.get_local_variable_count(source_frame_index)
		var local_count := mini(source_local_count, mini(256, MAX_VARIABLES - captured_variables))
		for variable_index in local_count:
			locals.append(_variable(
				backtrace.get_local_variable_name(source_frame_index, variable_index),
				backtrace.get_local_variable_value(source_frame_index, variable_index),
			))
		captured_variables += local_count
		var source_member_count := backtrace.get_member_variable_count(source_frame_index)
		var member_count := mini(source_member_count, mini(256, MAX_VARIABLES - captured_variables))
		for variable_index in member_count:
			members.append(_variable(
				backtrace.get_member_variable_name(source_frame_index, variable_index),
				backtrace.get_member_variable_value(source_frame_index, variable_index),
			))
		captured_variables += member_count
		_frame_scopes.append({
			"locals": locals,
			"members": members,
			"localsTruncated": source_local_count > local_count,
			"membersTruncated": source_member_count > member_count,
		})
		_frames.append({
			"id": frame_index,
			"name": backtrace.get_frame_function(source_frame_index),
			"source": {"path": source_path},
			"line": backtrace.get_frame_line(source_frame_index),
			"column": 0,
		})
	var source_global_count := backtrace.get_global_variable_count()
	var global_count := mini(source_global_count, mini(256, MAX_VARIABLES - captured_variables))
	_globals_truncated = source_global_count > global_count
	for variable_index in global_count:
		_globals.append(_variable(
			backtrace.get_global_variable_name(variable_index),
			backtrace.get_global_variable_value(variable_index),
		))
	return _stack_page(offset, limit)

static func game_frame_score(source_paths: Array[String]) -> int:
	var score := 0
	for source_path in source_paths:
		var normalized := source_path.to_lower()
		if normalized.begins_with("res://") and not normalized.begins_with("res://addons/godot_mcp/"):
			score += 1
	return score

func _stack_page(offset: int, limit: int) -> Dictionary:
	var total := _frames.size()
	var start := clampi(offset, 0, total)
	var finish := mini(start + clampi(limit, 1, MAX_FRAMES), total)
	return {"ok": true, "data": {"body": {"stackFrames": _frames.slice(start, finish), "totalFrames": total}}}

func variables(frame_index: int, scope: String, offset: int, limit: int) -> Dictionary:
	if frame_index < 0 or frame_index >= _frame_scopes.size():
		return _error("STALE_HANDLE", "Debugger frame is stale or unavailable")
	var entries: Array[Dictionary] = []
	var capture_truncated := false
	match scope:
		"locals":
			entries.assign(_frame_scopes[frame_index].locals)
			capture_truncated = bool(_frame_scopes[frame_index].get("localsTruncated", false))
		"members":
			entries.assign(_frame_scopes[frame_index].members)
			capture_truncated = bool(_frame_scopes[frame_index].get("membersTruncated", false))
		"globals":
			entries.assign(_globals)
			capture_truncated = _globals_truncated
		_:
			return _error("INVALID_REQUEST", "Debugger scope is invalid")
	return _page(entries, offset, limit, capture_truncated)

func children(reference: int, offset: int, limit: int) -> Dictionary:
	if not _references.has(reference):
		return _error("STALE_HANDLE", "Debugger variable reference is stale or unavailable")
	var value: Variant = _references[reference]
	var entries: Array[Dictionary] = []
	var source_size: int = int(value.size())
	var bounded_total := mini(source_size, MAX_VARIABLES)
	var start := clampi(offset, 0, bounded_total)
	var finish := mini(start + clampi(limit, 1, 256), bounded_total)
	if typeof(value) == TYPE_DICTIONARY:
		var index := 0
		for key: Variant in value:
			if index >= finish:
				break
			if index >= start:
				if typeof(key) == TYPE_STRING:
					entries.append(_variable(str(key), value[key], "string", key))
				elif typeof(key) == TYPE_INT or typeof(key) == TYPE_FLOAT:
					entries.append(_variable(str(key), value[key], "number", key))
				else:
					entries.append(_variable(_unsupported_key_name(key), value[key], "unsupported"))
			index += 1
	elif typeof(value) == TYPE_ARRAY:
		for index in range(start, finish):
			entries.append(_variable(str(index), value[index], "number", index))
	else:
		return _error("PRECONDITION_FAILED", "Debugger variable has no safe children")
	return {"ok": true, "data": {"body": {
		"variables": entries,
		"totalVariables": bounded_total,
		"truncated": source_size > bounded_total or finish < bounded_total,
	}}}

func clear() -> void:
	_clear_snapshot()

func _page(entries: Array[Dictionary], offset: int, limit: int, capture_truncated := false) -> Dictionary:
	var bounded_total := mini(entries.size(), MAX_VARIABLES)
	var start := clampi(offset, 0, bounded_total)
	var finish := mini(start + clampi(limit, 1, 256), bounded_total)
	return {"ok": true, "data": {"body": {
		"variables": entries.slice(start, finish),
		"totalVariables": bounded_total,
		"truncated": capture_truncated or entries.size() > bounded_total or finish < bounded_total,
	}}}

func _variable(name: String, value: Variant, selector_kind := "string", selector_value: Variant = null) -> Dictionary:
	var safe_name := _bounded_name(name)
	var resolved_selector: Variant = name if selector_value == null else selector_value
	var selector_metadata := {"selectorKind": "unsupported"}
	if selector_kind == "string" and _valid_string_selector(resolved_selector):
		selector_metadata = {"selectorKind": "string", "selectorValue": resolved_selector}
	elif selector_kind == "number" and _valid_number_selector(resolved_selector):
		selector_metadata = {"selectorKind": "number", "selectorValue": resolved_selector}
	if VariantEncoder.is_secret_name(name):
		return {
			"name": safe_name,
			"type": type_string(typeof(value)),
			"value": "[redacted]",
			"valueTruncated": false,
			"variablesReference": 0,
		}.merged(selector_metadata)
	var reference := 0
	if (typeof(value) == TYPE_ARRAY or typeof(value) == TYPE_DICTIONARY) and _references.size() < MAX_VARIABLES:
		reference = _next_reference
		_next_reference += 1
		_references[reference] = value
	var display := _bounded_text(_display_value(value))
	return {
		"name": safe_name,
		"type": type_string(typeof(value)).left(128),
		"value": display.text,
		"valueTruncated": display.truncated,
		"variablesReference": reference,
	}.merged(selector_metadata)

func _unsupported_key_name(key: Variant) -> String:
	if typeof(key) == TYPE_OBJECT:
		if not is_instance_valid(key):
			return "<freed Object>"
		return "<%s#%d>" % [key.get_class(), key.get_instance_id()]
	return "<%s>" % type_string(typeof(key))

static func _valid_string_selector(value: Variant) -> bool:
	if typeof(value) != TYPE_STRING or String(value).is_empty() or String(value).length() > 128:
		return false
	for index in String(value).length():
		if String(value).unicode_at(index) == 0:
			return false
	return true

static func _valid_number_selector(value: Variant) -> bool:
	return typeof(value) == TYPE_INT and int(value) >= 0 and int(value) <= 1_000_000

static func _bounded_name(value: String) -> String:
	var prefix := value.left(128)
	var output := ""
	for index in prefix.length():
		output += "?" if prefix.unicode_at(index) == 0 else prefix.substr(index, 1)
	return output

func _display_value(value: Variant) -> String:
	if typeof(value) == TYPE_STRING:
		return value
	if typeof(value) == TYPE_OBJECT:
		if not is_instance_valid(value):
			return "<freed Object>"
		return "<%s#%d>" % [value.get_class(), value.get_instance_id()]
	if typeof(value) == TYPE_ARRAY:
		return "Array(size=%d)" % value.size()
	if typeof(value) == TYPE_DICTIONARY:
		return "Dictionary(size=%d)" % value.size()
	if typeof(value) in [
		TYPE_PACKED_BYTE_ARRAY,
		TYPE_PACKED_INT32_ARRAY,
		TYPE_PACKED_INT64_ARRAY,
		TYPE_PACKED_FLOAT32_ARRAY,
		TYPE_PACKED_FLOAT64_ARRAY,
		TYPE_PACKED_STRING_ARRAY,
		TYPE_PACKED_VECTOR2_ARRAY,
		TYPE_PACKED_VECTOR3_ARRAY,
		TYPE_PACKED_COLOR_ARRAY,
		TYPE_PACKED_VECTOR4_ARRAY,
	]:
		return "%s(size=%d)" % [type_string(typeof(value)), value.size()]
	return str(value)

func _bounded_text(value: String) -> Dictionary:
	# A Unicode scalar occupies at least one UTF-8 byte, so this prefix is enough
	# to decide truncation without encoding an attacker-sized original string.
	var prefix := value.left(MAX_TEXT_BYTES + 1)
	if prefix.length() == value.length() and prefix.to_utf8_buffer().size() <= MAX_TEXT_BYTES:
		return {"text": value, "truncated": false}
	var low := 0
	var high := mini(prefix.length(), MAX_TEXT_BYTES)
	while low < high:
		var middle := int((low + high + 1) / 2)
		if prefix.left(middle).to_utf8_buffer().size() <= MAX_TEXT_BYTES:
			low = middle
		else:
			high = middle - 1
	return {"text": prefix.left(low), "truncated": true}

func _clear_snapshot() -> void:
	_frame_scopes.clear()
	_frames.clear()
	_globals.clear()
	_globals_truncated = false
	_references.clear()
	_next_reference = 1

static func _error(code: String, message: String) -> Dictionary:
	return {"ok": false, "code": code, "message": message.left(512), "retryable": false}
