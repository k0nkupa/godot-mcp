@tool
class_name GodotMcpProjectOperations
extends RefCounted

const CanonicalJson = preload("res://addons/godot_mcp/bridge/canonical_json.gd")
const SessionCrypto = preload("res://addons/godot_mcp/bridge/session_crypto.gd")

const ALLOWED_PREFIXES := ["application/", "audio/", "display/", "input/", "navigation/", "physics/", "rendering/"]
const DENIED_PREFIXES := [
	"application/run/disable_stdout", "application/run/disable_stderr", "application/run/main_run_args",
	"application/run/main_scene", "application/run/load_shell_environment", "editor_plugins/", "autoload/", "network/", "filesystem/", "gdextension/",
]

var _editor: Variant
var _filesystem: Variant

func _init(editor: Variant, filesystem: Variant) -> void:
	_editor = editor
	_filesystem = filesystem

func execute(arguments: Dictionary) -> Dictionary:
	match String(arguments.get("operation", "")):
		"settings_apply": return _settings_apply(arguments)
		"plugin_set": return _plugin_set(arguments)
		"reimport": return _reimport(arguments)
	return _error("INVALID_REQUEST", "Unknown project operation")

static func setting_name_is_allowed(name: String) -> bool:
	if name.length() < 3 or name.length() > 128 or _string_contains_zero(name):
		return false
	var allowed := false
	for prefix: String in ALLOWED_PREFIXES:
		if name.begins_with(prefix): allowed = true
	if not allowed: return false
	for prefix: String in DENIED_PREFIXES:
		if name.begins_with(prefix): return false
	for part: String in name.split("/", false):
		if part.is_empty(): return false
		for index in part.length():
			var character := part.unicode_at(index)
			if not (
				(character >= 65 and character <= 90) or (character >= 97 and character <= 122)
				or (character >= 48 and character <= 57) or character in [46, 95, 45]
			): return false
	return true

static func plugin_path_is_allowed(path: String) -> bool:
	if path == "res://addons/godot_mcp/plugin.cfg" or not path.begins_with("res://addons/") or not path.ends_with("/plugin.cfg"):
		return false
	var relative := path.trim_prefix("res://addons/").trim_suffix("/plugin.cfg")
	if relative.is_empty() or relative.contains("/") or relative.length() > 64:
		return false
	for index in relative.length():
		var character := relative.unicode_at(index)
		if not ((character >= 65 and character <= 90) or (character >= 97 and character <= 122) or (character >= 48 and character <= 57) or character in [95, 45]):
			return false
	return true

static func project_file_is_contained(path: String) -> bool:
	if not path.begins_with("res://") or _string_contains_zero(path) or ".." in path.trim_prefix("res://").split("/", false):
		return false
	var components := path.trim_prefix("res://").split("/", false)
	if components.is_empty():
		return false
	var project_root := ProjectSettings.globalize_path("res://").simplify_path().trim_suffix("/")
	var absolute := ProjectSettings.globalize_path(path).simplify_path()
	if not absolute.begins_with(project_root + "/"):
		return false
	var current := project_root
	for component: String in components:
		var directory := DirAccess.open(current)
		if directory == null or directory.is_link(component):
			return false
		current = current.path_join(component)
	return FileAccess.file_exists(current)

static func setting_value_is_allowed(value: Variant) -> bool:
	if typeof(value) == TYPE_NIL or typeof(value) == TYPE_BOOL or typeof(value) == TYPE_INT:
		return true
	if typeof(value) == TYPE_FLOAT:
		return not is_nan(value) and not is_inf(value)
	if typeof(value) != TYPE_STRING:
		return false
	var text := String(value)
	if text.length() > 4096 or _string_contains_zero(text):
		return false
	var lowered := text.to_lower()
	if text.begins_with("/") or text.begins_with("~/") or text.begins_with("\\\\") or "://" in text:
		return false
	return not (text.length() >= 3 and text.unicode_at(1) == 58 and text.unicode_at(2) in [47, 92]) and not lowered.begins_with("file:")

static func setting_value_sha256(value: Variant) -> String:
	return CanonicalJson.encode(SessionCrypto._canonical_signing_params(value)).sha256_text()

func _settings_apply(arguments: Dictionary) -> Dictionary:
	var changes: Variant = arguments.get("changes", [])
	if typeof(changes) != TYPE_ARRAY or changes.is_empty() or changes.size() > 32:
		return _error("INVALID_REQUEST", "Project setting change count is invalid")
	var preimages: Array[Dictionary] = []
	for raw_change: Variant in changes:
		if typeof(raw_change) != TYPE_DICTIONARY:
			return _error("INVALID_REQUEST", "Project setting change is invalid")
		var change := raw_change as Dictionary
		var name := String(change.get("name", ""))
		if not setting_name_is_allowed(name) or not change.has("value") or not setting_value_is_allowed(change.value):
			return _error("INVALID_REQUEST", "Project setting is not allowed")
		if change.has("expectedValue") and not setting_value_is_allowed(change.expectedValue):
			return _error("INVALID_REQUEST", "Project setting precondition is invalid")
		var exists := ProjectSettings.has_setting(name)
		var previous: Variant = ProjectSettings.get_setting(name) if exists else null
		if change.has("expectedValue") and change.expectedValue != previous:
			return _error("CONFLICT", "Project setting precondition changed")
		preimages.append({"name": name, "exists": exists, "value": previous})
	for index in changes.size():
		ProjectSettings.set_setting(String(changes[index].name), changes[index].value)
	var save_error := ProjectSettings.save()
	if save_error != OK:
		return _settings_rollback_failure(preimages, "Project settings could not be saved")
	for change: Dictionary in changes:
		if ProjectSettings.get_setting(String(change.name)) != change.value:
			return _settings_rollback_failure(preimages, "Project setting postcondition failed")
	var receipts: Array[Dictionary] = []
	for index in changes.size():
		receipts.append({
			"settingNameSha256": String(changes[index].name).sha256_text(),
			"preimageSha256": setting_value_sha256(preimages[index].value),
			"postimageSha256": setting_value_sha256(changes[index].value),
		})
	return {"ok": true, "data": {"operation": "settings_apply", "changes": receipts, "rollback": "not_needed"}}

func _plugin_set(arguments: Dictionary) -> Dictionary:
	var path := String(arguments.get("pluginPath", ""))
	if _editor == null or not plugin_path_is_allowed(path) or not project_file_is_contained(path):
		return _error("TARGET_NOT_FOUND", "Project plugin is unavailable or denied")
	var plugin_name := path.trim_prefix("res://addons/").trim_suffix("/plugin.cfg")
	var currently_enabled := bool(_editor.is_plugin_enabled(plugin_name))
	var persisted_before := ProjectSettings.get_setting("editor_plugins/enabled", PackedStringArray()) as PackedStringArray
	persisted_before = persisted_before.duplicate()
	if typeof(arguments.get("expectedEnabled")) != TYPE_BOOL or bool(arguments.expectedEnabled) != currently_enabled:
		return _error("CONFLICT", "Project plugin state changed")
	if typeof(arguments.get("enabled")) != TYPE_BOOL or bool(arguments.enabled) == currently_enabled:
		return _error("INVALID_REQUEST", "Project plugin operation must change state")
	_editor.set_plugin_enabled(plugin_name, bool(arguments.enabled))
	var save_error := ProjectSettings.save()
	var persisted_after := ProjectSettings.get_setting("editor_plugins/enabled", PackedStringArray()) as PackedStringArray
	if save_error != OK or bool(_editor.is_plugin_enabled(plugin_name)) != bool(arguments.enabled) or persisted_after.has(path) != bool(arguments.enabled):
		return _plugin_rollback_failure(plugin_name, currently_enabled, persisted_before, "Project plugin postcondition failed")
	return {"ok": true, "data": {"operation": "plugin_set", "pluginSha256": path.sha256_text(), "enabled": bool(arguments.enabled), "rollback": "not_needed"}}

func _reimport(arguments: Dictionary) -> Dictionary:
	var paths: Variant = arguments.get("resourcePaths", [])
	if _filesystem == null or typeof(paths) != TYPE_ARRAY or paths.is_empty() or paths.size() > 128:
		return _error("INVALID_REQUEST", "Selective reimport request is invalid")
	var validated := PackedStringArray()
	for raw_path: Variant in paths:
		var path := String(raw_path)
		if not path.begins_with("res://") or _string_contains_zero(path) or ".." in path.trim_prefix("res://").split("/", false):
			return _error("PATH_DENIED", "Selective reimport path is invalid")
		if path.begins_with("res://addons/godot_mcp/") or not project_file_is_contained(path):
			return _error("TARGET_NOT_FOUND", "Selective reimport source is unavailable or denied")
		validated.append(path)
	_filesystem.reimport_files(validated)
	return {"ok": true, "data": {"operation": "reimport", "resourceCount": validated.size()}}

func _restore_settings(preimages: Array[Dictionary]) -> void:
	for preimage in preimages:
		ProjectSettings.set_setting(preimage.name, preimage.value if preimage.exists else null)

func _settings_rollback_failure(preimages: Array[Dictionary], message: String) -> Dictionary:
	_restore_settings(preimages)
	var rollback := "succeeded" if ProjectSettings.save() == OK else "failed"
	return {"ok": false, "code": "GODOT_RUNTIME_ERROR" if rollback == "succeeded" else "ROLLBACK_FAILED", "message": message, "retryable": false, "partialEffects": rollback == "failed", "rollback": rollback}

func _plugin_rollback_failure(plugin_name: String, enabled: bool, persisted: PackedStringArray, message: String) -> Dictionary:
	_editor.set_plugin_enabled(plugin_name, enabled)
	ProjectSettings.set_setting("editor_plugins/enabled", persisted)
	var saved := ProjectSettings.save() == OK
	var restored := ProjectSettings.get_setting("editor_plugins/enabled", PackedStringArray()) as PackedStringArray
	var rollback := "succeeded" if saved and bool(_editor.is_plugin_enabled(plugin_name)) == enabled and restored == persisted else "failed"
	return {"ok": false, "code": "GODOT_RUNTIME_ERROR" if rollback == "succeeded" else "ROLLBACK_FAILED", "message": message, "retryable": false, "partialEffects": rollback == "failed", "rollback": rollback}

static func _error(code: String, message: String) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": false, "partialEffects": false, "rollback": "not_needed"}

static func _string_contains_zero(value: String) -> bool:
	for index in value.length():
		if value.unicode_at(index) == 0:
			return true
	return false
