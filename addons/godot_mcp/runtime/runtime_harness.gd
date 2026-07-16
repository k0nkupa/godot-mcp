class_name GodotMcpRuntimeHarness
extends Node

const DescriptorReader = preload("res://addons/godot_mcp/bridge/descriptor_reader.gd")
const SessionCrypto = preload("res://addons/godot_mcp/bridge/session_crypto.gd")
const RuntimeControl = preload("res://addons/godot_mcp/runtime/runtime_control.gd")
const RuntimeCapture = preload("res://addons/godot_mcp/runtime/runtime_capture.gd")
const RuntimeFrameClock = preload("res://addons/godot_mcp/runtime/runtime_frame_clock.gd")
const RuntimeInput = preload("res://addons/godot_mcp/runtime/runtime_input.gd")
const RuntimeLogger = preload("res://addons/godot_mcp/runtime/runtime_logger.gd")
const RuntimeQuery = preload("res://addons/godot_mcp/runtime/runtime_query.gd")

var _descriptor: Dictionary = {}
var _secret := PackedByteArray()
var _authenticated := false
var _receive_sequence := 0
var _game_scene: Node
var _logger: Logger
var _query: RefCounted
var _control: RefCounted
var _runtime_capture: RefCounted
var _runtime_input: RefCounted
var _next_owner_check_ms := 0
var _scene_revision := 0
var _pending_commands: Dictionary = {}

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	var path := descriptor_argument(OS.get_cmdline_user_args())
	if path.is_empty() or not descriptor_path_is_allowed(path, DescriptorReader.runtime_directory()):
		get_tree().quit(2)
		return
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(path))
	DirAccess.remove_absolute(path)
	if typeof(parsed) != TYPE_DICTIONARY or not descriptor_has_required_fields(parsed):
		get_tree().quit(2)
		return
	_descriptor = parsed
	if (
		int(_descriptor.expiresAtUnixMs) < _now_ms()
		or not EngineDebugger.is_active()
		or not owner_lease_path_is_allowed(String(_descriptor.ownerLeasePath), DescriptorReader.runtime_directory())
	):
		get_tree().quit(2)
		return
	_secret = SessionCrypto.base64url_decode(String(_descriptor.secret))
	_descriptor.secret = ""
	_logger = RuntimeLogger.new(ProjectSettings.globalize_path("res://"))
	OS.add_logger(_logger)
	EngineDebugger.register_message_capture("godot_mcp_runtime", _capture)
	var hello := {
		"runId": String(_descriptor.runId),
		"generation": int(_descriptor.generation),
		"projectId": String(_descriptor.project.projectId),
		"sessionId": String(_descriptor.sessionId),
		"launchNonce": String(_descriptor.launchNonce),
		"pid": OS.get_process_id(),
	}
	hello.proof = SessionCrypto.hmac_sha256(_secret, hello_signing_text(hello)).hex_encode()
	EngineDebugger.send_message("godot_mcp_runtime:hello", [hello])

func _process(_delta: float) -> void:
	if _descriptor.is_empty() or _now_ms() < _next_owner_check_ms:
		return
	_next_owner_check_ms = _now_ms() + 500
	var modified_unix_s := FileAccess.get_modified_time(String(_descriptor.get("ownerLeasePath", "")))
	if not owner_lease_is_fresh(modified_unix_s, _now_ms()):
		get_tree().quit(4)

func _exit_tree() -> void:
	if EngineDebugger.has_capture("godot_mcp_runtime"):
		EngineDebugger.unregister_message_capture("godot_mcp_runtime")
	if _logger != null:
		OS.remove_logger(_logger)
	_logger = null
	_release_runtime_input("runtime_exit")
	_query = null
	_control = null
	_runtime_capture = null
	_runtime_input = null
	var owner_lease_path := String(_descriptor.get("ownerLeasePath", ""))
	if owner_lease_path_is_allowed(owner_lease_path, DescriptorReader.runtime_directory()):
		DirAccess.remove_absolute(owner_lease_path)
	_secret.fill(0)
	_secret = PackedByteArray()
	_descriptor.clear()

func _capture(message: String, data: Array) -> bool:
	if data.size() != 1 or typeof(data[0]) != TYPE_DICTIONARY:
		return false
	var payload: Dictionary = data[0]
	if message == "hello_ok":
		if (
			String(payload.get("runId", "")) != String(_descriptor.runId)
			or int(payload.get("generation", 0)) != int(_descriptor.generation)
			or not payload.has("serverProof")
		):
			return true
		var hello := {
			"runId": String(_descriptor.runId),
			"generation": int(_descriptor.generation),
			"projectId": String(_descriptor.project.projectId),
			"sessionId": String(_descriptor.sessionId),
			"launchNonce": String(_descriptor.launchNonce),
			"pid": OS.get_process_id(),
		}
		hello.proof = SessionCrypto.hmac_sha256(_secret, hello_signing_text(hello)).hex_encode()
		if not valid_server_proof(_secret, hello, String(payload.serverProof)):
			return true
		_authenticated = true
		_secret.fill(0)
		_secret = PackedByteArray()
		_load_game_scene()
		return true
	if message != "command" or not _authenticated:
		return false
	_handle_command(payload)
	return true

func _load_game_scene() -> void:
	var resource := load(String(_descriptor.scenePath))
	if resource == null or not resource is PackedScene:
		get_tree().quit(3)
		return
	var tree := get_tree()
	tree.current_scene = null
	if tree.change_scene_to_packed(resource) != OK:
		tree.quit(3)
		return
	await tree.scene_changed
	_bind_game_scene()
	if _game_scene == null:
		tree.quit(3)
		return
	if not tree.scene_changed.is_connected(_bind_game_scene):
		tree.scene_changed.connect(_bind_game_scene)
	EngineDebugger.send_message("godot_mcp_runtime:ready", [{
		"runId": String(_descriptor.runId),
		"generation": int(_descriptor.generation),
		"pid": OS.get_process_id(),
	}])

func _bind_game_scene() -> void:
	_scene_revision += 1
	_cancel_stale_commands()
	_game_scene = get_tree().current_scene
	if _game_scene == null:
		_release_runtime_input("scene_missing")
		_query = null
		_control = null
		_runtime_capture = null
		_runtime_input = null
		return
	_query = RuntimeQuery.new(_game_scene, _logger)
	var frame_clock := RuntimeFrameClock.new(_game_scene)
	_control = RuntimeControl.new(_game_scene, _query, _logger, frame_clock)
	_runtime_capture = RuntimeCapture.new(_game_scene, _control)
	_runtime_input = RuntimeInput.new(_game_scene, frame_clock)
	_game_scene.tree_exiting.connect(_invalidate_game_scene.bind(_game_scene), CONNECT_ONE_SHOT)

func _invalidate_game_scene(scene: Node) -> void:
	if _game_scene != scene:
		return
	_scene_revision += 1
	_cancel_stale_commands()
	_release_runtime_input("scene_invalidated")
	_game_scene = null
	_query = null
	_control = null
	_runtime_capture = null
	_runtime_input = null

func _handle_command(command: Dictionary) -> void:
	var request_id := String(command.get("requestId", ""))
	var sequence := int(command.get("sequence", 0))
	var deadline := int(command.get("deadlineUnixMs", 0))
	var operation := String(command.get("operation", ""))
	var outcome: Dictionary
	if sequence <= _receive_sequence:
		outcome = _error("AUTHENTICATION_FAILED", "Runtime command sequence was replayed")
	elif deadline < _now_ms():
		outcome = _error("TIMEOUT", "Runtime command deadline expired", true)
	elif not operation_is_allowed(operation):
		outcome = _error("INVALID_REQUEST", "Runtime operation is not allowed")
	elif operation != "stop" and (
		_query == null
		or _control == null
		or _runtime_capture == null
		or _runtime_input == null
		or not is_instance_valid(_game_scene)
		or _game_scene.get_tree() == null
	):
		outcome = _error("TARGET_NOT_FOUND", "Runtime scene is changing", true)
	else:
		_receive_sequence = sequence
		var scene_revision := _scene_revision
		_pending_commands[request_id] = scene_revision
		outcome = await _execute_operation(operation, command.get("arguments", {}), deadline)
		if not _pending_commands.has(request_id):
			return
		if operation != "stop" and scene_revision != _scene_revision:
			outcome = _error("TARGET_NOT_FOUND", "Runtime scene changed during the operation", true)
		_pending_commands.erase(request_id)
	EngineDebugger.send_message("godot_mcp_runtime:result", [{
		"requestId": request_id,
		"outcome": outcome,
	}])
	if operation == "stop" and bool(outcome.get("ok", false)):
		call_deferred("_cooperative_stop")

func _cancel_stale_commands() -> void:
	for request_id: String in _pending_commands.keys():
		if int(_pending_commands[request_id]) == _scene_revision:
			continue
		_pending_commands.erase(request_id)
		EngineDebugger.send_message("godot_mcp_runtime:result", [{
			"requestId": request_id,
			"outcome": _error("TARGET_NOT_FOUND", "Runtime scene changed during the operation", true),
		}])

func _execute_operation(operation: String, arguments: Dictionary, deadline_unix_ms: int) -> Dictionary:
	match operation:
		"status", "tree", "node", "logs": return _query.execute(operation, arguments)
		"wait", "pause", "resume", "step": return await _control.execute(operation, arguments, deadline_unix_ms)
		"capture": return await _runtime_capture.execute(arguments, deadline_unix_ms)
		"input": return await _runtime_input.execute(arguments.get("input", null), deadline_unix_ms)
		"stop":
			return {"ok": true, "data": {"stopping": true}}
		_: return _error("INVALID_REQUEST", "Runtime operation is not implemented")

func _cooperative_stop() -> void:
	_release_runtime_input("runtime_stop")
	EngineDebugger.send_message("godot_mcp_runtime:stopped", [{"runId": String(_descriptor.runId)}])
	# Let both the command result and stopped notification reach the editor before
	# terminating the debugger transport.
	await get_tree().process_frame
	get_tree().quit(0)

func _release_runtime_input(reason: String) -> void:
	if _runtime_input != null:
		_runtime_input.release_all(reason)

static func descriptor_argument(arguments: PackedStringArray) -> String:
	var prefix := "--godot-mcp-runtime-descriptor="
	var found := ""
	for argument in arguments:
		if String(argument).begins_with(prefix):
			if not found.is_empty():
				return ""
			found = String(argument).substr(prefix.length())
	return found

static func descriptor_path_is_allowed(path: String, runtime_directory: String) -> bool:
	if path.is_empty() or runtime_directory.is_empty() or not path.is_absolute_path():
		return false
	var normalized_directory := runtime_directory.simplify_path()
	var normalized_path := path.simplify_path()
	return normalized_path.get_base_dir() == normalized_directory and normalized_path.get_file().begins_with("runtime-") and normalized_path.get_extension() == "json"

static func descriptor_has_required_fields(descriptor: Dictionary) -> bool:
	for field in ["project", "sessionId", "runId", "generation", "scenePath", "ownerLeasePath", "secret", "launchNonce", "expiresAtUnixMs"]:
		if not descriptor.has(field):
			return false
	return typeof(descriptor.project) == TYPE_DICTIONARY and descriptor.project.has("projectId")

static func operation_is_allowed(operation: String) -> bool:
	return operation in ["status", "tree", "node", "logs", "wait", "pause", "resume", "step", "stop", "capture", "input"]

static func owner_lease_path_is_allowed(path: String, runtime_directory: String) -> bool:
	if path.is_empty() or runtime_directory.is_empty() or not path.is_absolute_path():
		return false
	var normalized_path := path.simplify_path()
	return normalized_path.get_base_dir() == runtime_directory.simplify_path() and normalized_path.get_file().begins_with("runtime-") and normalized_path.get_extension() == "lease"

static func owner_lease_is_fresh(modified_unix_s: int, now_unix_ms: int) -> bool:
	# FileAccess reports whole seconds. The extra 999 ms prevents expiry before
	# the lease is actually three seconds old while retaining a strict bound.
	return modified_unix_s > 0 and now_unix_ms - modified_unix_s * 1000 <= 3999

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

static func valid_server_proof(proof_key: PackedByteArray, hello: Dictionary, received: String) -> bool:
	var expected := SessionCrypto.hmac_sha256(proof_key, server_proof_signing_text(hello)).hex_encode()
	return SessionCrypto.constant_time_equal(received, expected)

static func _now_ms() -> int:
	return int(Time.get_unix_time_from_system() * 1000.0)

static func _error(code: String, message: String, retryable := false) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": retryable}
