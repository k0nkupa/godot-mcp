class_name GodotMcpRuntimeHarness
extends Node

const DescriptorReader = preload("res://addons/godot_mcp/bridge/descriptor_reader.gd")
const SessionCrypto = preload("res://addons/godot_mcp/bridge/session_crypto.gd")

var _descriptor: Dictionary = {}
var _secret := PackedByteArray()
var _authenticated := false
var _receive_sequence := 0
var _game_scene: Node

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
	if int(_descriptor.expiresAtUnixMs) < _now_ms() or not EngineDebugger.is_active():
		get_tree().quit(2)
		return
	_secret = SessionCrypto.base64url_decode(String(_descriptor.secret))
	_descriptor.secret = ""
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

func _exit_tree() -> void:
	if EngineDebugger.has_capture("godot_mcp_runtime"):
		EngineDebugger.unregister_message_capture("godot_mcp_runtime")
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
		):
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
	_game_scene = resource.instantiate()
	get_tree().root.add_child(_game_scene)
	get_tree().current_scene = _game_scene

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
	else:
		_receive_sequence = sequence
		outcome = _execute_operation(operation, command.get("arguments", {}))
	EngineDebugger.send_message("godot_mcp_runtime:result", [{
		"requestId": request_id,
		"outcome": outcome,
	}])

func _execute_operation(operation: String, _arguments: Dictionary) -> Dictionary:
	match operation:
		"status": return {"ok": true, "data": {"running": true, "paused": get_tree().paused}}
		"stop":
			call_deferred("_cooperative_stop")
			return {"ok": true, "data": {"stopping": true}}
		_: return _error("INVALID_REQUEST", "Runtime operation is not implemented")

func _cooperative_stop() -> void:
	EngineDebugger.send_message("godot_mcp_runtime:stopped", [{"runId": String(_descriptor.runId)}])
	get_tree().quit(0)

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
	for field in ["project", "sessionId", "runId", "generation", "scenePath", "secret", "launchNonce", "expiresAtUnixMs"]:
		if not descriptor.has(field):
			return false
	return typeof(descriptor.project) == TYPE_DICTIONARY and descriptor.project.has("projectId")

static func operation_is_allowed(operation: String) -> bool:
	return operation in ["status", "tree", "node", "logs", "wait", "pause", "resume", "step", "stop", "capture"]

static func hello_signing_text(payload: Dictionary) -> String:
	return "godot-mcp:runtime-hello:v1\n%s\n%s\n%s\n%s\n%s\n%s" % [
		String(payload.runId),
		str(int(payload.generation)),
		String(payload.projectId),
		String(payload.sessionId),
		String(payload.launchNonce),
		str(int(payload.pid)),
	]

static func _now_ms() -> int:
	return int(Time.get_unix_time_from_system() * 1000.0)

static func _error(code: String, message: String, retryable := false) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": retryable}
