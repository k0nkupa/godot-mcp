class_name GodotMcpRuntimeInput
extends RefCounted

const CanonicalJson = preload("res://addons/godot_mcp/bridge/canonical_json.gd")
const EventFactory = preload("res://addons/godot_mcp/runtime/runtime_input_event_factory.gd")
const InputCoordinates = preload("res://addons/godot_mcp/runtime/runtime_input_coordinates.gd")
const InputState = preload("res://addons/godot_mcp/runtime/runtime_input_state.gd")
const InputTrace = preload("res://addons/godot_mcp/runtime/runtime_input_trace.gd")

var _root: Node
var _clock: RefCounted
var _state := InputState.new()
var _trace := InputTrace.new()

func _init(root: Node, frame_clock: RefCounted) -> void:
	_root = root
	_clock = frame_clock

func execute(input: Variant, deadline_unix_ms: int) -> Dictionary:
	if typeof(input) != TYPE_DICTIONARY:
		return _error("INVALID_REQUEST", "Input operation must be an object")
	var operation := String(input.get("operation", ""))
	match operation:
		"record_start": return _record_start(input)
		"record_stop": return _record_stop(input)
		"send": return await _execute_events(input, [{"frameOffset": 0, "event": input.get("event", null)}], false, deadline_unix_ms)
		"sequence": return await _execute_events(input, input.get("events", null), String(input.get("mode", "")) == "deterministic", deadline_unix_ms)
		"replay":
			var trace: Variant = input.get("trace", null)
			if typeof(trace) != TYPE_DICTIONARY or int(trace.get("schemaVersion", 0)) != 1:
				return _error("INVALID_REQUEST", "Input replay trace is invalid")
			return await _execute_events(input, trace.get("events", null), true, deadline_unix_ms, true)
		_: return _error("INVALID_REQUEST", "Input operation is not allowed")

func release_all(_reason: String) -> Dictionary:
	var released := _release_held_state()
	_trace.clear()
	return released

func _release_held_state() -> Dictionary:
	var released_kinds: Array[String] = []
	for spec: Dictionary in _state.release_specs():
		var delivered := _deliver_spec(spec)
		if not delivered.ok:
			continue
		var kind := String(spec.type)
		if kind not in released_kinds:
			released_kinds.append(kind)
	return {"ok": true, "releases": released_kinds}

func _record_start(input: Dictionary) -> Dictionary:
	var handle := _handle(input)
	if not handle.ok: return handle
	var started := _trace.start(Engine.get_process_frames())
	if not started.ok: return started
	var empty_trace := {"schemaVersion": 1, "events": []}
	return {"ok": true, "data": {"receipt": _receipt(handle.value, "record_start", [], false, true, [], empty_trace)}}

func _record_stop(input: Dictionary) -> Dictionary:
	var handle := _handle(input)
	if not handle.ok: return handle
	var stopped := _trace.stop()
	if not stopped.ok: return stopped
	var trace: Dictionary = stopped.trace
	var event_receipts: Array[Dictionary] = []
	for index in trace.events.size():
		var item: Dictionary = trace.events[index]
		event_receipts.append(_event_receipt(index, item.event, int(item.frameOffset), int(item.frameOffset)))
	return {"ok": true, "data": {
		"receipt": _receipt(handle.value, "record_stop", event_receipts, false, false, [], trace),
		"trace": trace,
	}}

func _execute_events(input: Dictionary, value: Variant, deterministic: bool, deadline_unix_ms: int, allow_empty := false) -> Dictionary:
	var handle := _handle(input)
	if not handle.ok: return handle
	if typeof(value) != TYPE_ARRAY or (value.is_empty() and not allow_empty) or value.size() > 256:
		return _error("INVALID_REQUEST", "Input sequence size is invalid")
	var tree := _root.get_tree() if is_instance_valid(_root) else null
	if tree == null: return _error("TARGET_NOT_FOUND", "Runtime scene changed", true)
	if deterministic and not tree.paused:
		return _error("PRECONDITION_FAILED", "Deterministic input requires a paused runtime")
	if not deterministic and String(input.operation) == "sequence" and tree.paused:
		return _error("PRECONDITION_FAILED", "Realtime input requires a running runtime")
	if not _trace.can_append(value.size()):
		return _error("PAYLOAD_TOO_LARGE", "Input recording would exceed 256 events")
	if value.is_empty():
		var empty_trace := {"schemaVersion": 1, "events": []}
		return {"ok": true, "data": {"receipt": _receipt(handle.value, String(input.operation), [], deterministic, _trace.is_active(), [], empty_trace)}}
	var previous_offset := 0
	for index in value.size():
		var item: Variant = value[index]
		if typeof(item) != TYPE_DICTIONARY or not item.has("frameOffset") or not item.has("event"):
			return _error("INVALID_REQUEST", "Input trace event is invalid")
		var offset_value: Variant = item.frameOffset
		if typeof(offset_value) not in [TYPE_INT, TYPE_FLOAT] or float(offset_value) != floor(float(offset_value)):
			return _error("INVALID_REQUEST", "Input frame offset is invalid")
		var offset := int(offset_value)
		if offset < previous_offset or offset < 0 or offset > 1800:
			return _error("INVALID_REQUEST", "Input frame offsets must be bounded and nondecreasing")
		previous_offset = offset
	var receipts: Array[Dictionary] = []
	var current_offset := 0
	for index in value.size():
		if _now_ms() >= deadline_unix_ms:
			_release_held_state()
			return _error("TIMEOUT", "Input sequence deadline expired", true)
		var item: Dictionary = value[index]
		var target_offset := int(item.frameOffset)
		var delta := target_offset - current_offset
		if delta > 0:
			var advanced := await _advance(delta, deterministic, deadline_unix_ms)
			if not advanced.ok:
				_release_held_state()
				return advanced
			current_offset = target_offset
		var delivered := _deliver_spec(item.event, not deterministic)
		if not delivered.ok:
			_release_held_state()
			return delivered
		var recorded := _trace.append(item.event, Engine.get_process_frames())
		if not recorded.ok:
			_release_held_state()
			return recorded
		receipts.append(_event_receipt(index, item.event, target_offset, current_offset))
	if deterministic:
		var final_advance := await _advance(1, true, deadline_unix_ms)
		if not final_advance.ok:
			_release_held_state()
			return final_advance
	var trace := {"schemaVersion": 1, "events": value.duplicate(true)}
	return {"ok": true, "data": {"receipt": _receipt(handle.value, String(input.operation), receipts, deterministic, _trace.is_active(), [], trace)}}

func _advance(frames: int, deterministic: bool, deadline_unix_ms: int) -> Dictionary:
	if deterministic:
		return await _clock.advance_paused(frames, deadline_unix_ms)
	for _frame in frames:
		if _now_ms() >= deadline_unix_ms:
			return _error("TIMEOUT", "Input sequence deadline expired", true)
		await _root.get_tree().process_frame
		if not is_instance_valid(_root):
			return _error("TARGET_NOT_FOUND", "Runtime scene changed", true)
	return {"ok": true}

func _deliver_spec(spec: Variant, flush_global := true) -> Dictionary:
	var built := EventFactory.build(spec)
	if not built.ok: return built
	if built.route == "global":
		for event: InputEvent in built.events:
			Input.parse_input_event(event)
		if flush_global:
			Input.flush_buffered_events()
	else:
		for event: InputEvent in built.events:
			var resolved := InputCoordinates.resolve(_root, event, spec)
			if not resolved.ok: return resolved
			resolved.viewport.push_input(event, bool(resolved.inLocalCoords))
	_state.observe(spec)
	return {"ok": true}

func _handle(input: Dictionary) -> Dictionary:
	var handle: Variant = input.get("handle", null)
	if typeof(handle) != TYPE_DICTIONARY or not handle.has("runId") or not handle.has("generation"):
		return _error("INVALID_REQUEST", "Input runtime handle is invalid")
	return {"ok": true, "value": {"runId": String(handle.runId), "generation": int(handle.generation)}}

static func _receipt(handle: Dictionary, operation: String, events: Array[Dictionary], deterministic: bool, recording: bool, releases: Array, trace: Dictionary) -> Dictionary:
	return {
		"handle": handle,
		"operation": operation,
		"eventCount": events.size(),
		"deliveredCount": events.size(),
		"deterministic": deterministic,
		"events": events,
		"releases": releases,
		"traceSha256": trace_sha256(trace),
		"recording": recording,
	}

static func _event_receipt(index: int, spec: Dictionary, scheduled_frame: int, delivered_frame: int) -> Dictionary:
	var receipt := {
		"index": index,
		"kind": String(spec.type),
		"scheduledFrame": scheduled_frame,
		"deliveredFrame": delivered_frame,
	}
	if spec.has("viewportPath"):
		receipt.viewportPath = String(spec.viewportPath)
		receipt.coordinateSpace = String(spec.coordinateSpace)
	return receipt

static func trace_sha256(trace: Dictionary) -> String:
	var encoded := CanonicalJson.encode(trace)
	return encoded.sha256_text() if not encoded.is_empty() else ""

static func _now_ms() -> int:
	return int(Time.get_unix_time_from_system() * 1000.0)

static func _error(code: String, message: String, retryable := false) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": retryable}
