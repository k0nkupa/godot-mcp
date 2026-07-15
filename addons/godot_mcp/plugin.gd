@tool
extends EditorPlugin

func _enter_tree() -> void:
	print("GODOT_MCP_ADDON_ENTERED")

func _exit_tree() -> void:
	print("GODOT_MCP_ADDON_EXITED")
