@tool
class_name GodotMcpMainThreadQueue
extends Node

signal completed(request_id: String, result: Dictionary)
signal failed(request_id: String, code: String, message: String, retryable: bool)

const MAX_PENDING := 32

var _pending: Array[Dictionary] = []
var _handler: Callable
var _active := false
var _closed := false

func set_handler(handler: Callable) -> void:
	_handler = handler

func enqueue(command: Dictionary) -> bool:
	if _closed or _pending.size() >= MAX_PENDING:
		return false
	_pending.append(command.duplicate(true))
	if is_inside_tree() and not _active:
		call_deferred("_run_next")
	return true

func clear() -> void:
	_closed = true
	_pending.clear()

func _run_next() -> void:
	if _closed or _active or _pending.is_empty():
		return
	_active = true
	var command: Dictionary = _pending.pop_front()
	var request_id := String(command.get("requestId", ""))
	var now_ms := int(Time.get_unix_time_from_system() * 1000.0)
	if int(command.get("deadlineUnixMs", 0)) < now_ms:
		failed.emit(request_id, "TIMEOUT", "Command deadline expired", true)
	else:
		var outcome: Variant
		if not _handler.is_valid():
			outcome = {"ok": false, "code": "INVALID_REQUEST", "message": "No command handler", "retryable": false}
		else:
			outcome = await _handler.call(command)
		if typeof(outcome) != TYPE_DICTIONARY:
			failed.emit(request_id, "GODOT_RUNTIME_ERROR", "Command returned an invalid result", false)
		elif bool(outcome.get("ok", false)):
			completed.emit(request_id, outcome.get("data", {}))
		else:
			failed.emit(request_id, String(outcome.get("code", "GODOT_RUNTIME_ERROR")), String(outcome.get("message", "Godot command failed")), bool(outcome.get("retryable", false)))
	_active = false
	if not _pending.is_empty():
		call_deferred("_run_next")
