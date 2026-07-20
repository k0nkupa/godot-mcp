extends SceneTree

const ProjectOperations = preload("res://addons/godot_mcp/project/project_operations.gd")

class FakeEditor:
	extends RefCounted
	var enabled := false
	func is_plugin_enabled(_plugin: String) -> bool: return enabled
	func set_plugin_enabled(plugin: String, value: bool) -> void:
		enabled = value
		var path := "res://addons/%s/plugin.cfg" % plugin
		var persisted := ProjectSettings.get_setting("editor_plugins/enabled", PackedStringArray()) as PackedStringArray
		persisted = persisted.duplicate()
		if value and not persisted.has(path): persisted.append(path)
		if not value and persisted.has(path): persisted.remove_at(persisted.find(path))
		ProjectSettings.set_setting("editor_plugins/enabled", persisted)

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
	assert(ProjectOperations.setting_value_sha256(1.5) == "a25d5408a653d657c8fa1e163e4eecc0006d04b3dafb3a0518fe990c93f63263")
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
