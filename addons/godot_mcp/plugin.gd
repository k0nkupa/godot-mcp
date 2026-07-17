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

func _enter_tree() -> void:
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
	# Retain the configured port so settings changes cannot reopen native DAP.
	dap_guard = TCPServer.new()
	dap_disabled = not servers.is_empty() and dap_guard.listen(_runtime_dap_port(), "127.0.0.1") == OK

func _dap_server_is_disabled() -> bool:
	return dap_disabled and dap_guard != null and dap_guard.is_listening()

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
