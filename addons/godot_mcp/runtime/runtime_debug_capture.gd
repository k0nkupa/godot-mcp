class_name GodotMcpRuntimeDebugCapture
extends RefCounted

const VariantEncoder = preload("res://addons/godot_mcp/observation/variant_encoder.gd")
const MAX_FRAMES := 64
const MAX_VARIABLES := 2048
const MAX_TEXT_BYTES := 4096

var _frame_scopes: Array[Dictionary] = []
var _frames: Array[Dictionary] = []
var _globals: Array[Dictionary] = []
var _references: Dictionary = {}
var _next_reference := 1

func stack(offset: int, limit: int) -> Dictionary:
	if not _frames.is_empty():
		return _stack_page(offset, limit)
	_clear_snapshot()
	var backtrace: ScriptBacktrace
	for candidate: ScriptBacktrace in Engine.capture_script_backtraces(true):
		if candidate.get_language_name() == "GDScript" and not candidate.is_empty():
			backtrace = candidate
			break
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
		var local_count := mini(backtrace.get_local_variable_count(source_frame_index), mini(256, MAX_VARIABLES - captured_variables))
		for variable_index in local_count:
			locals.append(_variable(
				backtrace.get_local_variable_name(source_frame_index, variable_index),
				backtrace.get_local_variable_value(source_frame_index, variable_index),
			))
		captured_variables += local_count
		var member_count := mini(backtrace.get_member_variable_count(source_frame_index), mini(256, MAX_VARIABLES - captured_variables))
		for variable_index in member_count:
			members.append(_variable(
				backtrace.get_member_variable_name(source_frame_index, variable_index),
				backtrace.get_member_variable_value(source_frame_index, variable_index),
			))
		captured_variables += member_count
		_frame_scopes.append({"locals": locals, "members": members})
		_frames.append({
			"id": frame_index,
			"name": backtrace.get_frame_function(source_frame_index),
			"source": {"path": source_path},
			"line": backtrace.get_frame_line(source_frame_index),
			"column": 0,
		})
	var global_count := mini(backtrace.get_global_variable_count(), mini(256, MAX_VARIABLES - captured_variables))
	for variable_index in global_count:
		_globals.append(_variable(
			backtrace.get_global_variable_name(variable_index),
			backtrace.get_global_variable_value(variable_index),
		))
	return _stack_page(offset, limit)

func _stack_page(offset: int, limit: int) -> Dictionary:
	var total := _frames.size()
	var start := clampi(offset, 0, total)
	var finish := mini(start + clampi(limit, 1, MAX_FRAMES), total)
	return {"ok": true, "data": {"body": {"stackFrames": _frames.slice(start, finish), "totalFrames": total}}}

func variables(frame_index: int, scope: String, offset: int, limit: int) -> Dictionary:
	if frame_index < 0 or frame_index >= _frame_scopes.size():
		return _error("STALE_HANDLE", "Debugger frame is stale or unavailable")
	var entries: Array[Dictionary]
	match scope:
		"locals": entries = _frame_scopes[frame_index].locals
		"members": entries = _frame_scopes[frame_index].members
		"globals": entries = _globals
		_:
			return _error("INVALID_REQUEST", "Debugger scope is invalid")
	return _page(entries, offset, limit)

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

func _page(entries: Array[Dictionary], offset: int, limit: int) -> Dictionary:
	var bounded_total := mini(entries.size(), MAX_VARIABLES)
	var start := clampi(offset, 0, bounded_total)
	var finish := mini(start + clampi(limit, 1, 256), bounded_total)
	return {"ok": true, "data": {"body": {
		"variables": entries.slice(start, finish),
		"totalVariables": bounded_total,
		"truncated": entries.size() > bounded_total or finish < bounded_total,
	}}}

func _variable(name: String, value: Variant, selector_kind := "string", selector_value: Variant = null) -> Dictionary:
	var safe_name := name.left(128)
	var selector_metadata := {"selectorKind": selector_kind}
	if selector_kind == "string" or selector_kind == "number":
		selector_metadata.selectorValue = safe_name if selector_value == null else selector_value
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
	if key is Object:
		return "<%s#%d>" % [key.get_class(), key.get_instance_id()]
	return "<%s>" % type_string(typeof(key))

func _display_value(value: Variant) -> String:
	if value is Object:
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
	if value.to_utf8_buffer().size() <= MAX_TEXT_BYTES:
		return {"text": value, "truncated": false}
	var low := 0
	var high := value.length()
	while low < high:
		var middle := int((low + high + 1) / 2)
		if value.left(middle).to_utf8_buffer().size() <= MAX_TEXT_BYTES:
			low = middle
		else:
			high = middle - 1
	return {"text": value.left(low), "truncated": true}

func _clear_snapshot() -> void:
	_frame_scopes.clear()
	_frames.clear()
	_globals.clear()
	_references.clear()
	_next_reference = 1

static func _error(code: String, message: String) -> Dictionary:
	return {"ok": false, "code": code, "message": message.left(512), "retryable": false}
