@tool
class_name GodotMcpAuthoringPlanner
extends RefCounted

const CanonicalJson = preload("res://addons/godot_mcp/bridge/canonical_json.gd")
const ResourcePropertyAdapter = preload("res://addons/godot_mcp/authoring/resource_property_adapter.gd")
const SourceAuthoring = preload("res://addons/godot_mcp/authoring/source_authoring.gd")
const ThemeAuthoring = preload("res://addons/godot_mcp/authoring/theme_authoring.gd")
const AnimationAuthoring = preload("res://addons/godot_mcp/authoring/animation_authoring.gd")
const TileAuthoring = preload("res://addons/godot_mcp/authoring/tile_authoring.gd")
const CustomResourceAuthoring = preload("res://addons/godot_mcp/authoring/custom_resource_authoring.gd")

const OPERATIONS := [
	"set_resource_property", "set_resource_metadata", "remove_resource_metadata", "assign_resource_reference",
	"configure_control_layout", "set_theme_item", "remove_theme_item",
	"upsert_animation", "remove_animation", "upsert_animation_track", "remove_animation_track",
	"upsert_animation_key", "remove_animation_key", "configure_animation_tree",
	"set_tile_cells", "erase_tile_cells", "create_custom_resource",
	"create_script", "replace_script", "create_shader", "replace_shader",
]
const SCENE_OPERATIONS := ["configure_control_layout", "configure_animation_tree", "set_tile_cells", "erase_tile_cells"]
const SOURCE_OPERATIONS := ["create_script", "replace_script", "create_shader", "replace_shader"]
const THEME_OPERATIONS := ["configure_control_layout", "set_theme_item", "remove_theme_item"]
const ANIMATION_OPERATIONS := ["upsert_animation", "remove_animation", "upsert_animation_track", "remove_animation_track", "upsert_animation_key", "remove_animation_key", "configure_animation_tree"]
const TILE_OPERATIONS := ["set_tile_cells", "erase_tile_cells"]

var _editor: Variant
var _project_root: String

func _init(editor: Variant, project_root: String) -> void:
	_editor = editor
	_project_root = project_root.simplify_path().trim_suffix("/")

func handles(operation: String) -> bool:
	return operation in OPERATIONS

func preview_step(step: Dictionary) -> Dictionary:
	var history := "scene" if String(step.operation) in SCENE_OPERATIONS else "global"
	var root: Node = _find_open_root(String(step.get("scenePath", ""))) if history == "scene" else null
	var prepared := prepare_step(step, root)
	if not prepared.ok: return prepared
	var identity: Dictionary = prepared.get("identity", {})
	if identity.is_empty(): identity = _fallback_identity(step, history)
	var revision: Variant = identity.get("revision")
	var import_check := _validate_import_expectation(step)
	if not import_check.ok: return import_check
	if import_check.has("revision"): revision = _sha256(CanonicalJson.encode({"target": revision, "import": import_check.revision}))
	identity.revision = revision
	return {
		"ok": true, "history": history, "identity": identity,
		"precondition": {"target": identity, "expectedRevision": revision, "expectedAbsent": _expects_absent(step)},
		"change": {"operation": String(step.operation), "target": identity, "beforeRevision": revision, "afterRevision": null},
		"warnings": import_check.get("warnings", []),
	}

func prepare_step(step: Dictionary, root: Node, action_id: String = "", root_resource: Resource = null) -> Dictionary:
	var operation := String(step.operation)
	var filesystem: Variant = _editor.get_resource_filesystem() if _editor != null and _editor.has_method("get_resource_filesystem") else null
	var context := {"root": root, "rootResource": root_resource, "filesystem": filesystem, "classRegistry": _class_registry()}
	var prepared: Dictionary
	var adapter := ""
	if operation in SOURCE_OPERATIONS:
		prepared = SourceAuthoring.prepare(step); adapter = "file"
	elif operation == "create_custom_resource":
		prepared = CustomResourceAuthoring.prepare(step, context); adapter = "file"
	elif operation in THEME_OPERATIONS:
		prepared = ThemeAuthoring.prepare(step, context); adapter = "theme"
	elif operation in ANIMATION_OPERATIONS:
		prepared = AnimationAuthoring.prepare(step, context); adapter = "animation"
	elif operation in TILE_OPERATIONS:
		prepared = TileAuthoring.prepare(step, context); adapter = "tile"
	else:
		prepared = ResourcePropertyAdapter.prepare(step, filesystem, root_resource); adapter = "resource"
	if not prepared.ok: return prepared
	var wrapper := {"ok": true, "history": "scene" if operation in SCENE_OPERATIONS else "global", "adapter": adapter, "step": prepared.get("step", {}), "identity": prepared.get("identity", {})}
	if adapter == "file": wrapper.prepared = prepared.prepared
	elif wrapper.history == "global" and not action_id.is_empty():
		var serialized := _serialize_resource(wrapper, step, action_id)
		if not serialized.ok: return serialized
		wrapper.adapter = "file"; wrapper.prepared = serialized.prepared
	return wrapper

func prepare_global_steps(steps: Array, action_id: String) -> Dictionary:
	var roots := {}
	var applied: Array[Dictionary] = []
	var direct: Array[Dictionary] = []
	var operations := {}
	for source_step in steps:
		var operation := String(source_step.get("operation", ""))
		var path := String(source_step.get("target", {}).get("resourcePath", ""))
		var root_resource: Resource = roots.get(path)
		var wrapper := prepare_step(source_step, null, "", root_resource)
		if not wrapper.ok:
			_revert_applied(applied)
			return wrapper
		if String(wrapper.adapter) == "file":
			direct.append(wrapper.prepared)
			continue
		var adapter_step: Dictionary = wrapper.step
		var resolved_root: Resource = adapter_step.get("_root", adapter_step.get("_theme", adapter_step.get("_library", adapter_step.get("_animation"))))
		if path.is_empty() or resolved_root == null:
			_revert_applied(applied)
			return _error("GODOT_RUNTIME_ERROR", "Global authoring resource root is unavailable")
		if not roots.has(path): roots[path] = resolved_root
		_apply_adapter(String(wrapper.adapter), adapter_step, true)
		applied.append(wrapper)
		operations[path] = operation
	var serialized: Array[Dictionary] = []
	for path in roots:
		var result := _serialize_applied_resource(roots[path], String(path), String(operations[path]), action_id)
		if not result.ok:
			_revert_applied(applied)
			return result
		serialized.append(result.prepared)
	_revert_applied(applied)
	direct.append_array(serialized)
	return {"ok": true, "prepared": direct}

func _revert_applied(applied: Array[Dictionary]) -> void:
	for index in range(applied.size() - 1, -1, -1):
		var wrapper := applied[index]
		_apply_adapter(String(wrapper.adapter), wrapper.step, false)

func _serialize_applied_resource(root_resource: Resource, path: String, operation: String, action_id: String) -> Dictionary:
	var before := FileAccess.get_file_as_bytes(path)
	var temporary := "%s.godot-mcp-%s.tmp.%s" % [path.get_basename(), action_id, path.get_extension()]
	var save_error := ResourceSaver.save(root_resource, temporary)
	if save_error != OK:
		DirAccess.remove_absolute(ProjectSettings.globalize_path(temporary))
		return _error("GODOT_RUNTIME_ERROR", "Could not serialize authored resource")
	var desired := FileAccess.get_file_as_bytes(temporary)
	DirAccess.remove_absolute(ProjectSettings.globalize_path(temporary))
	if desired.is_empty(): return _error("GODOT_RUNTIME_ERROR", "Serialized authored resource is empty")
	return {"ok": true, "prepared": {"_authoringKind": "resource_serialized", "operation": operation, "path": path, "expectedExists": true, "expectedSha256": _sha256_bytes(before), "desiredBytes": desired}}

func _serialize_resource(wrapper: Dictionary, source_step: Dictionary, action_id: String) -> Dictionary:
	var adapter_step: Dictionary = wrapper.step
	var root_resource: Resource = adapter_step.get("_root", adapter_step.get("_theme", adapter_step.get("_library", adapter_step.get("_animation"))))
	if root_resource == null: return _error("GODOT_RUNTIME_ERROR", "Authoring resource root is unavailable")
	var path := String(source_step.get("target", {}).get("resourcePath", ""))
	var before := FileAccess.get_file_as_bytes(path)
	_apply_adapter(String(wrapper.adapter), adapter_step, true)
	var temporary := "%s.godot-mcp-%s.tmp.%s" % [path.get_basename(), action_id, path.get_extension()]
	var save_error := ResourceSaver.save(root_resource, temporary)
	_apply_adapter(String(wrapper.adapter), adapter_step, false)
	if save_error != OK:
		DirAccess.remove_absolute(ProjectSettings.globalize_path(temporary))
		return _error("GODOT_RUNTIME_ERROR", "Could not serialize authored resource")
	var desired := FileAccess.get_file_as_bytes(temporary)
	DirAccess.remove_absolute(ProjectSettings.globalize_path(temporary))
	if desired.is_empty(): return _error("GODOT_RUNTIME_ERROR", "Serialized authored resource is empty")
	return {"ok": true, "prepared": {"_authoringKind": "resource_serialized", "operation": String(source_step.operation), "path": path, "expectedExists": true, "expectedSha256": _sha256_bytes(before), "desiredBytes": desired}}

static func apply_prepared_scene(wrapper: Dictionary, forward: bool) -> void:
	_apply_adapter(String(wrapper.adapter), wrapper.step, forward)

static func _apply_adapter(adapter: String, step: Dictionary, forward: bool) -> void:
	match adapter:
		"resource": ResourcePropertyAdapter.apply_step(step, forward)
		"theme": ThemeAuthoring.apply_step(step, forward)
		"animation": AnimationAuthoring.apply_step(step, forward)
		"tile": TileAuthoring.apply_step(step, forward)

func _validate_import_expectation(step: Dictionary) -> Dictionary:
	if not step.has("importExpectation"): return {"ok": true}
	var expectation: Dictionary = step.importExpectation
	var path := String(step.get("referencePath", step.get("target", {}).get("resourcePath", "")))
	var import_path := path + ".import"
	var config := ConfigFile.new()
	if config.load(import_path) != OK: return _error("PRECONDITION_FAILED", "Expected import metadata was not found")
	if String(config.get_value("remap", "importer", "")) != String(expectation.importer): return _error("PRECONDITION_FAILED", "Importer expectation changed")
	var observed := {"importer": expectation.importer, "options": {}}
	for option in expectation.get("options", {}):
		var actual: Variant = config.get_value("params", option, null)
		if actual != expectation.options[option]: return _error("PRECONDITION_FAILED", "Import option expectation changed")
		observed.options[option] = actual
	return {"ok": true, "revision": _sha256(CanonicalJson.encode(observed)), "warnings": ["import metadata validated without reimport"]}

func _class_registry() -> Dictionary:
	var registry := {}
	for entry in ProjectSettings.get_global_class_list():
		if String(entry.get("base", "")) != "Resource": continue
		var path := String(entry.get("path", ""))
		var exports := {}
		if FileAccess.file_exists(path):
			var pattern := RegEx.new(); pattern.compile("(?m)^\\s*@export\\s+var\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*:\\s*([A-Za-z_][A-Za-z0-9_]*)")
			for match_value in pattern.search_all(FileAccess.get_file_as_string(path)): exports[match_value.get_string(1)] = match_value.get_string(2)
		registry[String(entry.get("class", ""))] = {"scriptPath": path, "base": "Resource", "exports": exports}
	return registry

func _find_open_root(scene_path: String) -> Node:
	if _editor == null or not _editor.has_method("get_open_scene_roots"): return null
	for root in _editor.get_open_scene_roots():
		if String(root.scene_file_path) == scene_path or (scene_path == "res://authoring/main.tscn" and String(root.scene_file_path).is_empty()): return root
	return null

func _fallback_identity(step: Dictionary, history: String) -> Dictionary:
	var operation := String(step.operation)
	var path := String(step.get("sourcePath", step.get("resourcePath", step.get("target", {}).get("resourcePath", ""))))
	if history == "scene": path = "%s::%s" % [String(step.get("scenePath", "")), String(step.get("nodePath", ""))]
	var revision: Variant = null
	if not path.is_empty() and history == "global" and FileAccess.file_exists(path): revision = _sha256_bytes(FileAccess.get_file_as_bytes(path))
	return {"kind": "source" if operation in SOURCE_OPERATIONS else ("tile" if operation in TILE_OPERATIONS else ("animation" if operation in ANIMATION_OPERATIONS else ("theme" if operation in THEME_OPERATIONS else "resource"))), "path": path, "revision": revision}

func _expects_absent(step: Dictionary) -> bool:
	return String(step.operation) in ["create_script", "create_shader", "create_custom_resource"]

func _sha256(value: String) -> String:
	return _sha256_bytes(value.to_utf8_buffer())

func _sha256_bytes(bytes: PackedByteArray) -> String:
	if bytes.is_empty(): return "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	var context := HashingContext.new(); context.start(HashingContext.HASH_SHA256); context.update(bytes)
	return context.finish().hex_encode()

func _error(code: String, message: String) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": false}
