class_name GodotMcpRuntimeInputTrace
extends RefCounted

const MAX_EVENTS := 256

var _active := false
var _first_delivered_process_frame := -1
var _events: Array[Dictionary] = []

func start(_process_frame: int) -> Dictionary:
	if _active:
		return _error("CONFLICT", "Input recording is already active")
	_active = true
	_first_delivered_process_frame = -1
	_events.clear()
	return {"ok": true}

func can_append(count: int) -> bool:
	return not _active or _events.size() + count <= MAX_EVENTS

func validate_append(delivered_process_frame: int) -> Dictionary:
	if not _active:
		return {"ok": true}
	if _events.size() >= MAX_EVENTS:
		return _error("PAYLOAD_TOO_LARGE", "Input recording reached 256 events")
	if _first_delivered_process_frame >= 0 and delivered_process_frame - _first_delivered_process_frame > 1800:
		return _error("PAYLOAD_TOO_LARGE", "Input recording exceeded 1800 frames")
	return {"ok": true}

func append(spec: Dictionary, delivered_process_frame: int) -> Dictionary:
	var valid := validate_append(delivered_process_frame)
	if not valid.ok or not _active:
		return valid
	if _first_delivered_process_frame < 0:
		_first_delivered_process_frame = delivered_process_frame
	_events.append({
		"frameOffset": maxi(0, delivered_process_frame - _first_delivered_process_frame),
		"event": spec.duplicate(true),
	})
	return {"ok": true}

func stop() -> Dictionary:
	if not _active:
		return _error("CONFLICT", "Input recording is not active")
	var trace := {"schemaVersion": 1, "events": _events.duplicate(true)}
	clear()
	return {"ok": true, "trace": trace}

func is_active() -> bool:
	return _active

func clear() -> void:
	_active = false
	_first_delivered_process_frame = -1
	_events.clear()

static func _error(code: String, message: String) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": false}
