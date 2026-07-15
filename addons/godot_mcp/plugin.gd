@tool
extends EditorPlugin

const BridgeClient = preload("res://addons/godot_mcp/bridge/bridge_client.gd")
const DescriptorReader = preload("res://addons/godot_mcp/bridge/descriptor_reader.gd")
const DiagnosticLogger = preload("res://addons/godot_mcp/observation/diagnostic_logger.gd")
const EditorQuery = preload("res://addons/godot_mcp/observation/editor_query.gd")
const EditorCapture = preload("res://addons/godot_mcp/observation/editor_capture.gd")
const MainThreadQueue = preload("res://addons/godot_mcp/commands/main_thread_queue.gd")

var bridge: Node
var command_queue: Node
var diagnostic_logger: Logger
var editor_query: RefCounted
var editor_capture: RefCounted

func _enter_tree() -> void:
	diagnostic_logger = DiagnosticLogger.new(ProjectSettings.globalize_path("res://"))
	OS.add_logger(diagnostic_logger)
	editor_query = EditorQuery.new(get_editor_interface(), diagnostic_logger)
	editor_capture = EditorCapture.new(get_editor_interface())
	command_queue = MainThreadQueue.new()
	command_queue.set_handler(_execute_command)
	add_child(command_queue)
	bridge = BridgeClient.new()
	add_child(bridge)
	bridge.command_received.connect(_on_command_received)
	command_queue.completed.connect(_on_command_completed)
	command_queue.failed.connect(_on_command_failed)
	bridge.start(DescriptorReader.read_project_identity())

func _on_command_received(command: Dictionary) -> void:
	if not command_queue.enqueue(command):
		bridge.send_command_error(String(command.get("requestId", "")), "CONFLICT", "Editor command queue is full", true)

func _execute_command(command: Dictionary) -> Dictionary:
	if String(command.method) == "editor.query":
		return editor_query.execute(command.arguments)
	if String(command.method) == "editor.capture":
		return await editor_capture.execute(command.arguments)
	return {"ok": false, "code": "INVALID_REQUEST", "message": "Unsupported editor command", "retryable": false}

func _on_command_completed(request_id: String, outcome: Dictionary) -> void:
	var chunks: Array = outcome.get("chunks", [])
	var binary: Dictionary = outcome.get("binary", {})
	for index in chunks.size():
		if not bridge.is_attached():
			return
		bridge.send_command_chunk(request_id, index, chunks.size(), String(binary.get("sha256", "")), String(chunks[index]))
	bridge.send_command_result(request_id, outcome.get("data", {}), binary)

func _on_command_failed(request_id: String, code: String, message: String, retryable: bool) -> void:
	bridge.send_command_error(request_id, code, message, retryable)

func _exit_tree() -> void:
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
