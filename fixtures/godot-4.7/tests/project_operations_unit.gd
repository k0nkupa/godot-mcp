extends SceneTree

const ProjectOperations = preload("res://addons/godot_mcp/project/project_operations.gd")

func _init() -> void:
	assert(ProjectOperations.setting_name_is_allowed("display/window/size/viewport_width"))
	assert(ProjectOperations.setting_name_is_allowed("application/config/name"))
	assert(not ProjectOperations.setting_name_is_allowed("editor_plugins/enabled"))
	assert(not ProjectOperations.setting_name_is_allowed("autoload/Backdoor"))
	assert(not ProjectOperations.setting_name_is_allowed("network/host"))
	assert(ProjectOperations.setting_value_is_allowed("Windowed"))
	assert(not ProjectOperations.setting_value_is_allowed("file:///tmp/secret"))
	assert(not ProjectOperations.setting_value_is_allowed("/tmp/secret"))
	assert(not ProjectOperations.setting_value_is_allowed({"host": "value"}))
	assert(ProjectOperations.plugin_path_is_allowed("res://addons/example/plugin.cfg"))
	assert(not ProjectOperations.plugin_path_is_allowed("res://addons/godot_mcp/plugin.cfg"))
	assert(not ProjectOperations.plugin_path_is_allowed("res://addons/../escape/plugin.cfg"))
	print("PHASE9_PROJECT_OPERATIONS_UNIT_OK")
	quit()
