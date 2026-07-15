extends SceneTree

func _init() -> void:
	var args := OS.get_cmdline_user_args()
	assert(args.size() == 1 and args[0] in ["enable", "disable"])
	var enabled := ProjectSettings.get_setting("editor_plugins/enabled", PackedStringArray()) as PackedStringArray
	var path := "res://addons/godot_mcp/plugin.cfg"
	if args[0] == "enable" and not enabled.has(path):
		enabled.append(path)
	if args[0] == "disable":
		var updated := PackedStringArray()
		for item in enabled:
			if item != path:
				updated.append(item)
		enabled = updated
	ProjectSettings.set_setting("editor_plugins/enabled", enabled)
	var error := ProjectSettings.save()
	quit(0 if error == OK else 1)
