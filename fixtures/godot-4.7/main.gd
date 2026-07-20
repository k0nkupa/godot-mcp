extends Node2D

func _ready() -> void:
	print("GODOT_MCP_MAIN_READY")
	if OS.has_feature("phase9_smoke"):
		print("PHASE9_STANDALONE_EXPORT_OK")
		get_tree().quit()
