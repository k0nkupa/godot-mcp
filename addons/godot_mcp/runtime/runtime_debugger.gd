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
	session.stopped.connect(func() -> void:
		if debugger_session_id == _bound_session_id:
			clear()
	)

func prepare(descriptor: Dictionary, debug_port: int, editor_pid: int) -> Dictionary:
	if _bound_session_id >= 0:
		return _error("CONFLICT", "A runtime is already prepared or attached")
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
	_prepared = descriptor.duplicate(true)
	if debug_port < 1 or debug_port > 65535:
		clear()
		return _error("GODOT_RUNTIME_ERROR", "Editor debugger port is invalid")
	return {"ok": true, "data": {"debugPort": debug_port, "editorPid": editor_pid}}

func execute(command: Dictionary) -> Dictionary:
	var operation := String(command.get("arguments", {}).get("operation", ""))
	var deadline := int(command.get("deadlineUnixMs", 0))
	if operation == "await_ready":
		while _ready_info.is_empty() and _now_ms() < deadline:
			await Engine.get_main_loop().process_frame
		if _ready_info.is_empty():
			return _error("TIMEOUT", "Runtime did not authenticate before the deadline", true)
		return {"ok": true, "data": _ready_info.duplicate(true)}
	if _bound_session_id < 0:
		return _error("NOT_ATTACHED", "No authenticated runtime is attached", true)
	if not _matches_handle(command.get("arguments", {}).get("handle", {})):
		return _error("STALE_HANDLE", "Runtime handle is stale")
	var request_id := String(command.get("requestId", ""))
	_pending[request_id] = null
	_send_sequence += 1
	get_session(_bound_session_id).send_message("godot_mcp_runtime:command", [{
		"handle": command.get("arguments", {}).get("handle", {}),
		"requestId": request_id,
		"sequence": _send_sequence,
		"deadlineUnixMs": deadline,
		"operation": operation,
		"arguments": command.get("arguments", {}),
	}])
	while _pending.has(request_id) and _pending[request_id] == null and _now_ms() < deadline:
		await Engine.get_main_loop().process_frame
	if not _pending.has(request_id) or _pending[request_id] == null:
		_pending.erase(request_id)
		return _error("TIMEOUT", "Runtime command timed out", true)
	var result: Dictionary = _pending[request_id]
	_pending.erase(request_id)
	return result

func clear() -> void:
	if _prepared.has("secret"):
		_prepared.secret = ""
	_prepared.clear()
	_pending.clear()
	_ready_info.clear()
	_bound_session_id = -1
	_send_sequence = 0

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
