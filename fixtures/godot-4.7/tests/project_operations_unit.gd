extends SceneTree

const ProjectOperations = preload("res://addons/godot_mcp/project/project_operations.gd")

class FakeEditor:
	extends RefCounted
	var enabled := false
	func is_plugin_enabled(_plugin: String) -> bool: return enabled
	func set_plugin_enabled(_plugin: String, value: bool) -> void: enabled = value

func _init() -> void:
	assert(ProjectOperations.setting_name_is_allowed("display/window/size/viewport_width"))
	assert(ProjectOperations.setting_name_is_allowed("application/config/name"))
	assert(not ProjectOperations.setting_name_is_allowed("editor_plugins/enabled"))
	assert(not ProjectOperations.setting_name_is_allowed("autoload/Backdoor"))
	assert(not ProjectOperations.setting_name_is_allowed("network/host"))
	assert(not ProjectOperations.setting_name_is_allowed("application/run/main_scene"))
	assert(not ProjectOperations.setting_name_is_allowed("application/run/load_shell_environment"))
	assert(ProjectOperations.setting_value_is_allowed("Windowed"))
	assert(not ProjectOperations.setting_value_is_allowed("file:///tmp/secret"))
	assert(not ProjectOperations.setting_value_is_allowed("/tmp/secret"))
	assert(not ProjectOperations.setting_value_is_allowed({"host": "value"}))
	assert(ProjectOperations.plugin_path_is_allowed("res://addons/example/plugin.cfg"))
	assert(not ProjectOperations.plugin_path_is_allowed("res://addons/godot_mcp/plugin.cfg"))
	assert(not ProjectOperations.plugin_path_is_allowed("res://addons/../escape/plugin.cfg"))
	assert(ProjectOperations.project_file_is_contained("res://icon.svg"))
	assert(not ProjectOperations.project_file_is_contained("res://linked-outside.svg"))
	assert(not ProjectOperations.project_file_is_contained("res://addons/external/plugin.cfg"))
	var editor := FakeEditor.new()
	var operations := ProjectOperations.new(editor, null)
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path("res://addons/example"))
	var plugin_file := FileAccess.open(ProjectSettings.globalize_path("res://addons/example/plugin.cfg"), FileAccess.WRITE)
	plugin_file.store_string("[plugin]\nname=\"Example\"\nscript=\"res://addons/example/plugin.gd\"\n")
	plugin_file = null
	assert(operations.execute({"operation": "plugin_set", "pluginPath": "res://addons/example/plugin.cfg", "expectedEnabled": false, "enabled": true}).ok)
	assert(editor.enabled)
	assert(operations.execute({"operation": "plugin_set", "pluginPath": "res://addons/example/plugin.cfg", "expectedEnabled": true, "enabled": false}).ok)
	assert(not editor.enabled)
	print("PHASE9_PROJECT_OPERATIONS_UNIT_OK")
	quit()
