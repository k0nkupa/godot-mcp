@tool
class_name GodotMcpRuntimeDebugger
extends EditorDebuggerPlugin

const SessionCrypto = preload("res://addons/godot_mcp/bridge/session_crypto.gd")

signal runtime_ready(info: Dictionary)
signal runtime_stopped(info: Dictionary)

var _prepared: Dictionary = {}
var _bound_session_id := -1
var _ready_info: Dictionary = {}
var _pending: Dictionary = {}
var _send_sequence := 0
var _active_sessions: Dictionary = {}
var _stop_sequence := 0
var _stop_events: Array[Dictionary] = []
var _expected_stop_reason := "breakpoint"
var _breakpoints: Dictionary = {}

const SCOPE_REFERENCE_BASE := 1000000

func _has_capture(capture: String) -> bool:
	return capture == "godot_mcp_runtime"

func _capture(message: String, data: Array, debugger_session_id: int) -> bool:
	if not message.begins_with("godot_mcp_runtime:") or data.size() != 1 or typeof(data[0]) != TYPE_DICTIONARY:
		return false
	var payload: Dictionary = data[0]
	match message:
		"godot_mcp_runtime:hello":
			_accept_hello(payload, debugger_session_id)
		"godot_mcp_runtime:ready":
			_accept_ready(payload, debugger_session_id)
		"godot_mcp_runtime:result":
			_accept_result(payload, debugger_session_id)
		"godot_mcp_runtime:stopped":
			if debugger_session_id == _bound_session_id:
				runtime_stopped.emit(payload.duplicate(true))
		_:
			return false
	return true

func _setup_session(debugger_session_id: int) -> void:
	var session := get_session(debugger_session_id)
	session.started.connect(func() -> void:
		_active_sessions[debugger_session_id] = true
		if _bound_session_id >= 0 and debugger_session_id != _bound_session_id:
			clear("ambiguous_session")
	)
	session.stopped.connect(func() -> void:
		_active_sessions.erase(debugger_session_id)
		if debugger_session_id == _bound_session_id:
			_clear_after_session_stopped(debugger_session_id)
	)
	session.breaked.connect(func(can_debug: bool) -> void:
		if debugger_session_id != _bound_session_id or not can_debug:
			return
		_stop_sequence += 1
		_stop_events.append({"sequence": _stop_sequence, "reason": _expected_stop_reason})
		if _stop_events.size() > 512:
			_stop_events.pop_front()
		_expected_stop_reason = "breakpoint"
	)
	session.continued.connect(func() -> void:
		if debugger_session_id == _bound_session_id:
			_expected_stop_reason = "breakpoint"
	)

func _clear_after_session_stopped(debugger_session_id: int) -> void:
	# The runtime sends its cooperative-stop result immediately before closing
	# the debugger peer. Let the already-queued capture drain before pending
	# request state is cleared.
	await Engine.get_main_loop().process_frame
	if debugger_session_id == _bound_session_id and not _active_sessions.has(debugger_session_id):
		clear("session_stopped")

func prepare(descriptor: Dictionary, debug_port: int, editor_pid: int, dap_disabled: bool) -> Dictionary:
	if _bound_session_id >= 0:
		return _error("CONFLICT", "A runtime is already prepared or attached")
	if not _active_sessions.is_empty():
		return _error("CONFLICT", "Another debugger session is already active")
	if not _prepared.is_empty():
		var expired := _now_ms() > int(_prepared.get("expiresAtUnixMs", 0))
		var replacement_session := String(_prepared.get("sessionId", "")) != String(descriptor.get("sessionId", ""))
		if expired or replacement_session:
			clear()
		else:
			return _error("CONFLICT", "A runtime is already prepared or attached")
	for field in ["project", "sessionId", "runId", "generation", "scenePath", "ownerLeasePath", "secret", "launchNonce", "expiresAtUnixMs"]:
		if not descriptor.has(field):
			return _error("INVALID_REQUEST", "Runtime preparation is missing required fields")
	if typeof(descriptor.project) != TYPE_DICTIONARY or not descriptor.project.has("projectId"):
		return _error("INVALID_REQUEST", "Runtime project identity is invalid")
	if not debug_port_is_valid(debug_port):
		return _error("GODOT_RUNTIME_ERROR", "Editor debugger port is invalid")
	if editor_pid < 1:
		return _error("GODOT_RUNTIME_ERROR", "Editor process identity is invalid")
	if not dap_disabled:
		return _error("AUTHENTICATION_FAILED", "Unauthenticated Godot DAP server is still active")
	_prepared = descriptor.duplicate(true)
	return {"ok": true, "data": {"debugPort": debug_port, "editorPid": editor_pid, "debugTransport": "authenticated-editor-session"}}

static func debug_port_is_valid(port: int) -> bool:
	return port >= 1 and port <= 65535

static func binding_is_unambiguous(active_session_ids: Array, bound_session_id: int) -> bool:
	return bound_session_id >= 0 and active_session_ids.size() == 1 and int(active_session_ids[0]) == bound_session_id

func execute(command: Dictionary) -> Dictionary:
	var operation := String(command.get("arguments", {}).get("operation", ""))
	var deadline := int(command.get("deadlineUnixMs", 0))
	if operation == "await_ready":
		while _ready_info.is_empty() and _now_ms() < deadline:
			await Engine.get_main_loop().process_frame
		if _ready_info.is_empty():
			return _error("TIMEOUT", "Runtime did not authenticate before the deadline", true)
		return {"ok": true, "data": _ready_info.duplicate(true)}
	if operation == "debug_binding_status":
		var bound_session := get_session(_bound_session_id) if _bound_session_id >= 0 else null
		return {"ok": true, "data": {
			"debuggerSessionId": _bound_session_id,
			"activeSessionCount": _active_sessions.size(),
			"unambiguous": binding_is_unambiguous(_active_sessions.keys(), _bound_session_id),
			"connected": bound_session != null and bound_session.is_active(),
			"stopped": bound_session != null and bound_session.is_breaked(),
			"stopSequence": _stop_sequence,
		}}
	if _bound_session_id < 0:
		return _error("NOT_ATTACHED", "No authenticated runtime is attached", true)
	if not _matches_handle(command.get("arguments", {}).get("handle", {})):
		return _error("STALE_HANDLE", "Runtime handle is stale")
	if operation == "debug_adapter":
		return await _execute_debug_adapter(command, deadline)
	return await _forward_runtime(command, operation, command.get("arguments", {}), deadline)

func _forward_runtime(command: Dictionary, operation: String, arguments: Dictionary, deadline: int) -> Dictionary:
	var request_id := String(command.get("requestId", ""))
	_pending[request_id] = null
	_send_sequence += 1
	get_session(_bound_session_id).send_message("godot_mcp_runtime:command", [{
		"handle": command.get("arguments", {}).get("handle", {}),
		"requestId": request_id,
		"sequence": _send_sequence,
		"deadlineUnixMs": deadline,
		"operation": operation,
		"arguments": arguments,
	}])
	while _pending.has(request_id) and _pending[request_id] == null and _now_ms() < deadline:
		await Engine.get_main_loop().process_frame
	if not _pending.has(request_id) or _pending[request_id] == null:
		_pending.erase(request_id)
		return _error("TIMEOUT", "Runtime command timed out", true)
	var result: Dictionary = _pending[request_id]
	_pending.erase(request_id)
	return result

func _execute_debug_adapter(command: Dictionary, deadline: int) -> Dictionary:
	var adapter_command := String(command.get("arguments", {}).get("command", ""))
	var arguments: Dictionary = command.get("arguments", {}).get("adapterArguments", {})
	var session := get_session(_bound_session_id)
	if session == null or not session.is_active():
		return _error("NOT_ATTACHED", "Authenticated debugger session is unavailable", true)
	match adapter_command:
		"status":
			return {"ok": true, "data": _debug_status(session)}
		"setBreakpoints":
			return _set_breakpoints(session, arguments)
		"threads":
			return {"ok": true, "data": {"body": {"threads": [{"id": 1, "name": "Main Thread"}]}}}
		"stackTrace":
			if not session.is_breaked(): return _error("PRECONDITION_FAILED", "Godot debugger is not stopped")
			return await _forward_runtime(command, "debug_stack_data", {
				"offset": int(arguments.get("startFrame", 0)),
				"limit": int(arguments.get("levels", 64)),
			}, deadline)
		"scopes":
			if not session.is_breaked(): return _error("PRECONDITION_FAILED", "Godot debugger is not stopped")
			var frame_id := int(arguments.get("frameId", -1))
			if frame_id < 0: return _error("INVALID_REQUEST", "Debugger frame identity is invalid")
			return {"ok": true, "data": {"body": {"scopes": [
				{"name": "Locals", "variablesReference": SCOPE_REFERENCE_BASE + frame_id * 3},
				{"name": "Members", "variablesReference": SCOPE_REFERENCE_BASE + frame_id * 3 + 1},
				{"name": "Globals", "variablesReference": SCOPE_REFERENCE_BASE + frame_id * 3 + 2},
			]}}}
		"variables":
			if not session.is_breaked(): return _error("PRECONDITION_FAILED", "Godot debugger is not stopped")
			var reference := int(arguments.get("variablesReference", 0))
			var page := {"offset": int(arguments.get("start", 0)), "limit": int(arguments.get("count", 100))}
			if reference >= SCOPE_REFERENCE_BASE:
				var encoded := reference - SCOPE_REFERENCE_BASE
				var scopes := ["locals", "members", "globals"]
				page.frameId = int(encoded / 3)
				page.scope = scopes[encoded % 3]
				return await _forward_runtime(command, "debug_variables_data", page, deadline)
			page.variablesReference = reference
			return await _forward_runtime(command, "debug_children_data", page, deadline)
		"pause":
			if session.is_breaked(): return _error("PRECONDITION_FAILED", "Godot debugger is already stopped")
			_expected_stop_reason = "pause"
			var pause_after := _stop_sequence
			session.send_message("break", [])
			var paused := await _wait_for_stop(pause_after, deadline)
			if not paused.ok: return paused
			return {"ok": true, "data": {"body": paused.data}}
		"continue":
			if not session.is_breaked(): return _error("PRECONDITION_FAILED", "Godot debugger must be stopped before continuing")
			var clear_result := await _forward_runtime(command, "debug_clear_data", {}, deadline)
			if not clear_result.ok: return clear_result
			session.send_message("continue", [])
			while session.is_breaked() and _now_ms() < deadline:
				await Engine.get_main_loop().process_frame
			if session.is_breaked(): return _error("TIMEOUT", "Godot debugger did not continue before the deadline", true)
			return {"ok": true, "data": {"body": {"allThreadsContinued": true}}}
		"next", "stepIn":
			if not session.is_breaked(): return _error("PRECONDITION_FAILED", "Godot debugger must be stopped before stepping")
			var clear_result := await _forward_runtime(command, "debug_clear_data", {}, deadline)
			if not clear_result.ok: return clear_result
			_expected_stop_reason = "step"
			session.send_message("next" if adapter_command == "next" else "step", [])
			return {"ok": true, "data": {"body": {}}}
		"wait":
			return await _wait_for_stop(int(arguments.get("afterSequence", 0)), deadline)
		"disconnect":
			return {"ok": true, "data": {"body": {}}}
		_:
			return _error("INVALID_REQUEST", "Authenticated debugger command is not allowed")

func _set_breakpoints(session: EditorDebuggerSession, arguments: Dictionary) -> Dictionary:
	var source: Dictionary = arguments.get("source", {})
	var localized := ProjectSettings.localize_path(String(source.get("path", "")))
	if not localized.begins_with("res://") or localized.to_lower().begins_with("res://addons/godot_mcp/") or not localized.ends_with(".gd"):
		return _error("INVALID_REQUEST", "Debugger breakpoint source is outside the project surface")
	var lines: Array[int] = []
	var response: Array[Dictionary] = []
	for entry: Variant in arguments.get("breakpoints", []):
		if typeof(entry) != TYPE_DICTIONARY or int(entry.get("line", 0)) < 1:
			return _error("INVALID_REQUEST", "Debugger breakpoint line is invalid")
		var line := int(entry.line)
		lines.append(line)
		response.append({"verified": true, "line": line})
	var previous: Array = _breakpoints.get(localized, [])
	for line: int in previous:
		session.set_breakpoint(localized, line, false)
	for line: int in lines:
		session.set_breakpoint(localized, line, true)
	if lines.is_empty(): _breakpoints.erase(localized)
	else: _breakpoints[localized] = lines
	return {"ok": true, "data": {"body": {"breakpoints": response}}}

func _wait_for_stop(after_sequence: int, deadline: int) -> Dictionary:
	while _now_ms() < deadline:
		for event: Dictionary in _stop_events:
			if int(event.sequence) > after_sequence:
				return {"ok": true, "data": event.duplicate(true)}
		await Engine.get_main_loop().process_frame
	return _error("TIMEOUT", "Timed out waiting for Godot debugger to stop", true)

func _debug_status(session: EditorDebuggerSession) -> Dictionary:
	return {"connected": session.is_active(), "stopped": session.is_breaked(), "stopSequence": _stop_sequence}

func clear(_reason := "requested") -> void:
	if _bound_session_id >= 0:
		var session := get_session(_bound_session_id)
		if session != null:
			for source: String in _breakpoints.keys():
				for line: int in _breakpoints[source]:
					session.set_breakpoint(source, line, false)
	if _prepared.has("secret"):
		_prepared.secret = ""
	_prepared.clear()
	_pending.clear()
	_ready_info.clear()
	_bound_session_id = -1
	_send_sequence = 0
	_stop_sequence = 0
	_stop_events.clear()
	_expected_stop_reason = "breakpoint"
	_breakpoints.clear()

func _accept_hello(payload: Dictionary, debugger_session_id: int) -> void:
	if _prepared.is_empty() or _bound_session_id >= 0 or _now_ms() > int(_prepared.expiresAtUnixMs):
		return
	for field in ["runId", "generation", "projectId", "sessionId", "launchNonce", "pid", "proof"]:
		if not payload.has(field):
			return
	if (
		String(payload.runId) != String(_prepared.runId)
		or int(payload.generation) != int(_prepared.generation)
		or String(payload.projectId) != String(_prepared.project.projectId)
		or String(payload.sessionId) != String(_prepared.sessionId)
		or String(payload.launchNonce) != String(_prepared.launchNonce)
	):
		return
	_active_sessions[debugger_session_id] = true
	if not binding_is_unambiguous(_active_sessions.keys(), debugger_session_id):
		return
	var secret := SessionCrypto.base64url_decode(String(_prepared.secret))
	var expected := SessionCrypto.hmac_sha256(secret, hello_signing_text(payload)).hex_encode()
	if not SessionCrypto.constant_time_equal(String(payload.proof), expected):
		secret.fill(0)
		return
	var server_proof := SessionCrypto.hmac_sha256(secret, server_proof_signing_text(payload)).hex_encode()
	secret.fill(0)
	_bound_session_id = debugger_session_id
	_prepared.secret = ""
	get_session(debugger_session_id).send_message("godot_mcp_runtime:hello_ok", [{
		"runId": String(payload.runId),
		"generation": int(payload.generation),
		"serverProof": server_proof,
	}])

func _accept_ready(payload: Dictionary, debugger_session_id: int) -> void:
	if debugger_session_id != _bound_session_id or _prepared.is_empty() or not _ready_info.is_empty():
		return
	if String(payload.get("runId", "")) != String(_prepared.runId) or int(payload.get("generation", 0)) != int(_prepared.generation):
		return
	_ready_info = {
		"handle": {"runId": String(payload.runId), "generation": int(payload.generation)},
		"pid": int(payload.get("pid", 0)),
		"scenePath": String(_prepared.scenePath),
		"debuggerSessionId": debugger_session_id,
	}
	runtime_ready.emit(_ready_info.duplicate(true))

func _accept_result(payload: Dictionary, debugger_session_id: int) -> void:
	if debugger_session_id != _bound_session_id:
		return
	var request_id := String(payload.get("requestId", ""))
	if not _pending.has(request_id) or _pending[request_id] != null:
		return
	_pending[request_id] = payload.get("outcome", _error("GODOT_RUNTIME_ERROR", "Runtime omitted its outcome"))

func _matches_handle(handle: Variant) -> bool:
	return (
		typeof(handle) == TYPE_DICTIONARY
		and String(handle.get("runId", "")) == String(_ready_info.get("handle", {}).get("runId", ""))
		and int(handle.get("generation", 0)) == int(_ready_info.get("handle", {}).get("generation", -1))
	)

static func hello_signing_text(payload: Dictionary) -> String:
	return "godot-mcp:runtime-hello:v1\n%s\n%s\n%s\n%s\n%s\n%s" % [
		String(payload.runId),
		str(int(payload.generation)),
		String(payload.projectId),
		String(payload.sessionId),
		String(payload.launchNonce),
		str(int(payload.pid)),
	]

static func server_proof_signing_text(payload: Dictionary) -> String:
	return "godot-mcp:runtime-server-proof:v1\n%s\n%s" % [
		hello_signing_text(payload),
		String(payload.proof),
	]

static func _now_ms() -> int:
	return int(Time.get_unix_time_from_system() * 1000.0)

static func _error(code: String, message: String, retryable := false) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": retryable}
