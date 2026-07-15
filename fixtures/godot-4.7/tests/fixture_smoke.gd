extends SceneTree

func _init() -> void:
	var packed := load("res://main.tscn") as PackedScene
	assert(packed != null)
	var scene := packed.instantiate()
	assert(scene.get_node("StatusLabel").text == "fixture-ready")
	print("GODOT_MCP_FIXTURE_OK")
	quit(0)
