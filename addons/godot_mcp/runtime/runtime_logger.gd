class_name GodotMcpRuntimeLogger
extends Logger

const DiagnosticLogger = preload("res://addons/godot_mcp/observation/diagnostic_logger.gd")

var _delegate: Logger

func _init(project_root: String) -> void:
	_delegate = DiagnosticLogger.new(project_root)

func _log_message(message: String, error: bool) -> void:
	_delegate._log_message(message, error)

func _log_error(function: String, file: String, line: int, code: String, rationale: String, editor_notify: bool, error_type: int, script_backtraces: Array[ScriptBacktrace]) -> void:
	_delegate._log_error(function, file, line, code, rationale, editor_notify, error_type, script_backtraces)

func read_after(sequence: int, levels: Array, limit: int) -> Array[Dictionary]:
	return _delegate.read_after(sequence, levels, limit)
