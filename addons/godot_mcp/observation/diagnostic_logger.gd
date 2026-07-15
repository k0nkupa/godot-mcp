@tool
class_name GodotMcpDiagnosticLogger
extends Logger

const VariantEncoder = preload("res://addons/godot_mcp/observation/variant_encoder.gd")
const MAX_RECORDS := 500

var _project_root: String
var _mutex := Mutex.new()
var _records: Array[Dictionary] = []
var _sequence := 0

func _init(project_root: String = "") -> void:
	_project_root = project_root

func record_for_test(level: String, message: String) -> void:
	_record(level, message, "", 0, "")

func read_after(after_sequence: int, levels: Array, limit: int) -> Array[Dictionary]:
	var output: Array[Dictionary] = []
	_mutex.lock()
	for record in _records:
		if int(record.sequence) > after_sequence and String(record.level) in levels:
			output.append(record.duplicate(true))
			if output.size() >= mini(limit, MAX_RECORDS):
				break
	_mutex.unlock()
	return output

func _log_message(message: String, error: bool) -> void:
	_record("error" if error else "log", message, "", 0, "")

func _log_error(function: String, file: String, line: int, code: String, rationale: String, _editor_notify: bool, error_type: int, _script_backtraces: Array[ScriptBacktrace]) -> void:
	var levels := ["error", "warning", "script", "shader"]
	var level: String = levels[clampi(error_type, 0, levels.size() - 1)]
	_record(level, rationale if not rationale.is_empty() else code, file, line, function)

func _record(level: String, message: String, source: String, line: int, function: String) -> void:
	_mutex.lock()
	_sequence += 1
	_records.append({
		"sequence": _sequence,
		"timestampUnixMs": int(Time.get_unix_time_from_system() * 1000.0),
		"level": level,
		"message": VariantEncoder.redact_text(message, _project_root),
		"source": VariantEncoder.redact_text(source, _project_root),
		"line": line,
		"function": function.left(256),
	})
	if _records.size() > MAX_RECORDS:
		_records.pop_front()
	_mutex.unlock()
