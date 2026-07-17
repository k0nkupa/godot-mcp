@tool
extends EditorPlugin

const BridgeClient = preload("res://addons/godot_mcp/bridge/bridge_client.gd")
const DescriptorReader = preload("res://addons/godot_mcp/bridge/descriptor_reader.gd")
const DiagnosticLogger = preload("res://addons/godot_mcp/observation/diagnostic_logger.gd")
const EditorQuery = preload("res://addons/godot_mcp/observation/editor_query.gd")
const EditorCapture = preload("res://addons/godot_mcp/observation/editor_capture.gd")
const MainThreadQueue = preload("res://addons/godot_mcp/commands/main_thread_queue.gd")
const RuntimeDebugger = preload("res://addons/godot_mcp/runtime/runtime_debugger.gd")
const EditorMutation = preload("res://addons/godot_mcp/mutation/editor_mutation.gd")

var bridge: Node
var command_queue: Node
var diagnostic_logger: Logger
var editor_query: RefCounted
var editor_capture: RefCounted
var runtime_debugger: EditorDebuggerPlugin
var editor_mutation: RefCounted
var dap_guard: TCPServer
var dap_disabled := false
var secure_launch_attested := false
var _next_runtime_owner_check_ms := 0

func _enter_tree() -> void:
	# Secure launches already prevent DAP from binding by sharing its port with
	# the earlier authenticated debugger listener. Defer only the native plugin's
	# idempotent shutdown until Godot has finished registering editor plugins.
	call_deferred("_disable_unauthenticated_dap_server")
	diagnostic_logger = DiagnosticLogger.new(ProjectSettings.globalize_path("res://"))
	OS.add_logger(diagnostic_logger)
	editor_query = EditorQuery.new(get_editor_interface(), diagnostic_logger)
	editor_capture = EditorCapture.new(get_editor_interface())
	editor_mutation = EditorMutation.new(get_editor_interface(), get_undo_redo(), ProjectSettings.globalize_path("res://"), func() -> int: return bridge.session_generation() if is_instance_valid(bridge) else 0)
	runtime_debugger = RuntimeDebugger.new()
	add_debugger_plugin(runtime_debugger)
	command_queue = MainThreadQueue.new()
	command_queue.set_handler(_execute_command)
	add_child(command_queue)
	bridge = BridgeClient.new()
	add_child(bridge)
	bridge.command_received.connect(_on_command_received)
	command_queue.failed.connect(_on_command_failed)
	bridge.start(DescriptorReader.read_project_identity())

func _on_command_received(command: Dictionary) -> void:
	if not command_queue.enqueue(command):
		bridge.send_command_error(String(command.get("requestId", "")), "CONFLICT", "Editor command queue is full", true)

func _execute_command(command: Dictionary) -> Dictionary:
	var outcome: Dictionary
	if String(command.method) == "editor.query":
		outcome = editor_query.execute(command.arguments)
	elif String(command.method) == "editor.capture":
		outcome = await editor_capture.execute(command.arguments)
	elif String(command.method) == "editor.mutate":
		outcome = editor_mutation.execute(command.arguments)
	elif String(command.method) == "runtime.prepare":
		outcome = runtime_debugger.prepare(
			command.arguments.get("descriptor", {}),
			_runtime_debug_port(),
			OS.get_process_id(),
			_dap_server_is_disabled(),
		)
	elif String(command.method) in ["runtime.command", "runtime.capture"]:
		outcome = await runtime_debugger.execute(command)
	elif String(command.method) == "runtime.cleanup":
		runtime_debugger.clear()
		outcome = {"ok": true, "data": {"cleaned": true}}
	else:
		outcome = {"ok": false, "code": "INVALID_REQUEST", "message": "Unsupported editor command", "retryable": false}
	await _deliver_command(command, outcome)
	return {"ok": true}

func _deliver_command(command: Dictionary, outcome: Dictionary) -> void:
	var request_id := String(command.get("requestId", ""))
	var deadline_unix_ms := int(command.get("deadlineUnixMs", 0))
	if not bool(outcome.get("ok", false)):
		bridge.send_command_error(request_id, String(outcome.get("code", "GODOT_RUNTIME_ERROR")), String(outcome.get("message", "Godot command failed")), bool(outcome.get("retryable", false)), {
			"failedPhase": outcome.get("failedPhase", "request"),
			"partialEffects": outcome.get("partialEffects", false),
			"rollback": outcome.get("rollback", "not_needed"),
			"safeRecovery": outcome.get("safeRecovery", "Review the error and retry only after correcting the request"),
		})
		return
	var chunks: Array = outcome.get("chunks", [])
	var binary: Dictionary = outcome.get("binary", {})
	for index in chunks.size():
		if not bridge.is_attached():
			return
		if not await bridge.send_command_chunk_flow_controlled(request_id, index, chunks.size(), String(binary.get("sha256", "")), String(chunks[index]), deadline_unix_ms):
			if bridge.is_attached():
				bridge.send_command_error(request_id, "TIMEOUT", "Command deadline expired during response delivery", true)
			return
	if int(Time.get_unix_time_from_system() * 1000.0) >= deadline_unix_ms:
		bridge.send_command_error(request_id, "TIMEOUT", "Command deadline expired during response delivery", true)
		return
	bridge.send_command_result(request_id, outcome.get("data", {}), binary, deadline_unix_ms)

func _on_command_failed(request_id: String, code: String, message: String, retryable: bool) -> void:
	bridge.send_command_error(request_id, code, message, retryable)

func _process(_delta: float) -> void:
	if runtime_debugger == null:
		return
	var now_ms := int(Time.get_unix_time_from_system() * 1000.0)
	if now_ms < _next_runtime_owner_check_ms:
		return
	_next_runtime_owner_check_ms = now_ms + 250
	if not runtime_debugger.owner_lease_expired(now_ms):
		return
	push_error("Godot MCP owner lease expired; stopping the editor-owned runtime")
	runtime_debugger.revoke_owned_runtime_lease("owner_lease_expired")
	if get_editor_interface().is_playing_scene():
		get_editor_interface().stop_playing_scene()

func _runtime_debug_port() -> int:
	for argument in OS.get_cmdline_user_args():
		var value := String(argument)
		if value.begins_with("--godot-mcp-debug-port="):
			var port := int(value.trim_prefix("--godot-mcp-debug-port="))
			if port >= 1 and port <= 65535:
				return port
	return int(get_editor_interface().get_editor_settings().get_setting("network/debug/remote_port"))

func _disable_unauthenticated_dap_server() -> void:
	var servers: Array[Node] = []
	_collect_dap_servers(get_tree().root, servers)
	for server: Node in servers:
		# Godot 4.7 starts an unauthenticated native DAP listener unconditionally.
		# Its EXIT_TREE notification calls the native idempotent stop() method
		# without freeing the editor-owned plugin node.
		server.notification(Node.NOTIFICATION_EXIT_TREE)
	# The certified launcher binds the authenticated editor debugger and native
	# DAP to the same port before this plugin loads. Godot starts the authenticated
	# debugger first, so native DAP never acquires a listener. Runtime debugging
	# remains disabled for ordinary launches that cannot prove this startup state.
	secure_launch_attested = _consume_secure_launch_attestation()
	dap_disabled = not servers.is_empty() and secure_launch_attested
	if dap_disabled:
		return
	# Best-effort containment for observe-only ordinary launches. This closes the
	# listener after startup but is intentionally insufficient for runtime.prepare.
	if dap_guard != null:
		dap_guard.stop()
	dap_guard = TCPServer.new()
	dap_guard.listen(_runtime_dap_port(), "127.0.0.1")

func _dap_server_is_disabled() -> bool:
	return dap_disabled and secure_launch_attested

func _consume_secure_launch_attestation() -> bool:
	var path := _secure_launch_attestation_path()
	var runtime_directory := DescriptorReader.runtime_directory()
	if not RuntimeDebugger.launch_attestation_path_is_allowed(path, runtime_directory) or not FileAccess.file_exists(path):
		return false
	var directory := DirAccess.open(path.get_base_dir())
	if directory == null or directory.is_link(path.get_file()):
		return false
	var permissions := FileAccess.get_unix_permissions(path)
	var file := FileAccess.open(path, FileAccess.READ)
	if permissions < 0 or (permissions & 63) != 0 or file == null or file.get_length() > 4096:
		return false
	var document := JSON.parse_string(file.get_as_text())
	file = null
	DirAccess.remove_absolute(path)
	if typeof(document) != TYPE_DICTIONARY:
		return false
	var identity := DescriptorReader.read_project_identity()
	return RuntimeDebugger.launch_attestation_matches(
		document,
		path,
		runtime_directory,
		String(identity.get("projectId", "")),
		_runtime_debug_port(),
		_runtime_dap_port(),
		int(Time.get_unix_time_from_system() * 1000.0),
	)

func _secure_launch_attestation_path() -> String:
	var result := ""
	for argument in OS.get_cmdline_user_args():
		var value := String(argument)
		if value.begins_with("--godot-mcp-editor-attestation="):
			if not result.is_empty():
				return ""
			result = value.trim_prefix("--godot-mcp-editor-attestation=")
	return result

func _collect_dap_servers(node: Node, output: Array[Node]) -> void:
	for child: Node in node.get_children():
		if child == self:
			continue
		if child.get_class() == "DebugAdapterServer":
			output.append(child)
		_collect_dap_servers(child, output)

func _runtime_dap_port() -> int:
	for argument in OS.get_cmdline_user_args():
		var value := String(argument)
		if value.begins_with("--godot-mcp-dap-port="):
			return int(value.trim_prefix("--godot-mcp-dap-port="))
	return int(get_editor_interface().get_editor_settings().get_setting("network/debug_adapter/remote_port"))

func _exit_tree() -> void:
	if dap_guard != null:
		dap_guard.stop()
	dap_guard = null
	dap_disabled = false
	secure_launch_attested = false
	if runtime_debugger != null:
		runtime_debugger.clear()
		remove_debugger_plugin(runtime_debugger)
		runtime_debugger = null
	if is_instance_valid(command_queue):
		command_queue.clear()
		command_queue.queue_free()
	if is_instance_valid(bridge):
		bridge.close("plugin_exit")
		bridge.queue_free()
	if diagnostic_logger != null:
		OS.remove_logger(diagnostic_logger)
	diagnostic_logger = null
	editor_query = null
	editor_capture = null
	if editor_mutation != null:
		editor_mutation.clear()
	editor_mutation = null
