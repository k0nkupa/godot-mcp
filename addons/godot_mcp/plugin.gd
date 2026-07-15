@tool
extends EditorPlugin

const BridgeClient = preload("res://addons/godot_mcp/bridge/bridge_client.gd")
const DescriptorReader = preload("res://addons/godot_mcp/bridge/descriptor_reader.gd")

var bridge: Node

func _enter_tree() -> void:
	print("GODOT_MCP_ADDON_ENTERED")
	bridge = BridgeClient.new()
	add_child(bridge)
	bridge.start(DescriptorReader.read_project_identity())

func _exit_tree() -> void:
	if is_instance_valid(bridge):
		bridge.close("plugin_exit")
		bridge.queue_free()
	print("GODOT_MCP_ADDON_EXITED")
