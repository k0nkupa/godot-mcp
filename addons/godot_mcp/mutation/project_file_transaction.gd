@tool
class_name GodotMcpProjectFileTransaction
extends RefCounted

const MAX_FILES := 8
const MAX_PREIMAGE_BYTES := 4 * 1024 * 1024
const RESOURCE_ALLOWLIST := ["Resource", "Gradient", "Curve", "Environment", "StandardMaterial3D"]

var project_root: String
var editor_filesystem: Variant
var action_id: String
var prepared: Array[Dictionary] = []
var failure := ""
var partial_effects := false
var rollback := "not_needed"

func _init(root_path: String, filesystem: Variant, id: String) -> void:
	project_root = root_path.simplify_path().trim_suffix("/")
	editor_filesystem = filesystem
	action_id = id

func prepare_steps(step_values: Array) -> Dictionary:
	var touched := {}
	var preimage_bytes := 0
	for value in step_values:
		var result := _prepare_step(value)
		if not result.ok: return result
		for path in result.step.paths:
			touched[path] = true
			var state: Dictionary = result.step.before[path]
			if state.exists: preimage_bytes += state.bytes.size()
		prepared.append(result.step)
	if touched.size() > MAX_FILES: return _error("PAYLOAD_TOO_LARGE", "Editor mutation may touch at most 8 project files")
	if preimage_bytes > MAX_PREIMAGE_BYTES: return _error("PAYLOAD_TOO_LARGE", "Editor mutation rollback preimages exceed 4 MiB")
	return {"ok": true}

func apply_all(forward: bool) -> void:
	failure = ""
	partial_effects = false
	rollback = "not_needed"
	var ordered := prepared if forward else prepared.duplicate()
	if not forward: ordered.reverse()
	var completed: Array[Dictionary] = []
	for step in ordered:
		var result := _apply_step(step, forward, true)
		if result.ok:
			completed.append(step)
			continue
		failure = String(result.message)
		var restored := true
		completed.reverse()
		for completed_step in completed:
			if not _apply_step(completed_step, not forward, false).ok: restored = false
		partial_effects = not restored
		rollback = "succeeded" if restored else "failed"
		return
	_refresh()

func _prepare_step(step_value: Dictionary) -> Dictionary:
	var step := step_value.duplicate(true)
	var operation := String(step.get("operation", ""))
	var source_key := "resourcePath" if "resource" in operation else "scenePath"
	var source := String(step.get(source_key, ""))
	var destination := String(step.get("destinationPath", ""))
	for path in [source, destination]:
		if not path.is_empty() and not _safe_path(path): return _error("INVALID_REQUEST", "Project file path is outside the allowed mutation surface")
	var before := {source: _capture(source)}
	var paths: Array[String] = [source]
	if not destination.is_empty():
		before[destination] = _capture(destination)
		paths.append(destination)
	if operation.begins_with("create_"):
		if before[source].exists: return _error("CONFLICT", "Destination project file already exists")
	elif not before[source].exists:
		return _error("TARGET_NOT_FOUND", "Source project file was not found")
	if not destination.is_empty() and before[destination].exists:
		return _error("CONFLICT", "Destination project file already exists")
	var after := before.duplicate(true)
	match operation:
		"create_scene", "create_resource":
			var generated := _generate_file(step, source)
			if not generated.ok: return generated
			after[source] = _state(true, generated.bytes)
		"duplicate_scene", "duplicate_resource":
			after[destination] = _state(true, before[source].bytes)
		"move_scene", "move_resource":
			after[source] = _state(false)
			after[destination] = _state(true, before[source].bytes)
		"delete_scene", "delete_resource": after[source] = _state(false)
		_: return _error("INVALID_REQUEST", "Unsupported project file mutation")
	return {"ok": true, "step": {"operation": operation, "paths": paths, "before": before, "after": after}}

func _apply_step(step: Dictionary, forward: bool, enforce_precondition: bool) -> Dictionary:
	var expected: Dictionary = step.before if forward else step.after
	var desired: Dictionary = step.after if forward else step.before
	for path in step.paths:
		if not _safe_path(path): return _error("CONFLICT", "Project file path changed after validation")
		if enforce_precondition and not _same_state(_capture(path), expected[path]):
			return _error("CONFLICT", "Project file changed after preview")
	var changed: Array[String] = []
	for path in step.paths:
		var result := _atomic_set(path, desired[path])
		if result.ok:
			changed.append(path)
			continue
		changed.reverse()
		for changed_path in changed: _atomic_set(changed_path, expected[changed_path])
		return result
	return {"ok": true}

func _atomic_set(path: String, state: Dictionary) -> Dictionary:
	var absolute := ProjectSettings.globalize_path(path)
	var parent := absolute.get_base_dir()
	if DirAccess.make_dir_recursive_absolute(parent) != OK: return _error("GODOT_RUNTIME_ERROR", "Could not create project file directory")
	if not state.exists:
		if not FileAccess.file_exists(absolute): return {"ok": true}
		var tombstone := _journal_path(path)
		if DirAccess.make_dir_recursive_absolute(tombstone.get_base_dir()) != OK: return _error("GODOT_RUNTIME_ERROR", "Could not create mutation journal")
		if DirAccess.rename_absolute(absolute, tombstone) != OK: return _error("GODOT_RUNTIME_ERROR", "Could not atomically remove project file")
		DirAccess.remove_absolute(tombstone)
		return {"ok": true}
	var temporary := "%s.godot-mcp-%s.tmp" % [absolute, action_id]
	var file := FileAccess.open(temporary, FileAccess.WRITE)
	if file == null: return _error("GODOT_RUNTIME_ERROR", "Could not create atomic project file temporary")
	file.store_buffer(state.bytes)
	file.flush()
	file.close()
	var backup := "%s.godot-mcp-%s.bak" % [absolute, action_id]
	var had_existing := FileAccess.file_exists(absolute)
	if had_existing and DirAccess.rename_absolute(absolute, backup) != OK:
		DirAccess.remove_absolute(temporary)
		return _error("GODOT_RUNTIME_ERROR", "Could not stage existing project file")
	if DirAccess.rename_absolute(temporary, absolute) != OK:
		if had_existing: DirAccess.rename_absolute(backup, absolute)
		DirAccess.remove_absolute(temporary)
		return _error("GODOT_RUNTIME_ERROR", "Could not commit atomic project file")
	if had_existing: DirAccess.remove_absolute(backup)
	return {"ok": true}

func _generate_file(step: Dictionary, destination: String) -> Dictionary:
	var temporary := "%s.godot-mcp-generate-%s.tmp.%s" % [destination.get_basename(), action_id, destination.get_extension()]
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(temporary).get_base_dir())
	var resource: Resource
	if String(step.operation) == "create_scene":
		var node: Node = ClassDB.instantiate(String(step.rootClassName))
		if node == null: return _error("INVALID_REQUEST", "Scene root class cannot be instantiated")
		node.name = String(step.rootName)
		var packed := PackedScene.new()
		var pack_error := packed.pack(node)
		node.free()
		if pack_error != OK: return _error("GODOT_RUNTIME_ERROR", "Could not pack the new scene")
		resource = packed
	else:
		var resource_class := String(step.className)
		if resource_class not in RESOURCE_ALLOWLIST: return _error("INVALID_REQUEST", "Resource class is outside the Phase 5 allowlist")
		resource = ClassDB.instantiate(resource_class)
		if resource == null: return _error("INVALID_REQUEST", "Resource class cannot be instantiated")
	var save_error := ResourceSaver.save(resource, temporary)
	if save_error != OK: return _error("GODOT_RUNTIME_ERROR", "Could not serialize the new project file")
	var bytes := FileAccess.get_file_as_bytes(temporary)
	DirAccess.remove_absolute(ProjectSettings.globalize_path(temporary))
	if bytes.is_empty(): return _error("GODOT_RUNTIME_ERROR", "Serialized project file is empty")
	return {"ok": true, "bytes": bytes}

func _capture(path: String) -> Dictionary:
	if not FileAccess.file_exists(path): return _state(false)
	return _state(true, FileAccess.get_file_as_bytes(path))

func _state(exists: bool, bytes: PackedByteArray = PackedByteArray()) -> Dictionary:
	return {"exists": exists, "bytes": bytes, "sha256": _sha256(bytes) if exists else ""}

func _same_state(left: Dictionary, right: Dictionary) -> bool:
	return left.exists == right.exists and (not left.exists or left.sha256 == right.sha256)

func _safe_path(path: String) -> bool:
	if not path.begins_with("res://") or ".." in path.trim_prefix("res://").split("/") or _contains_nul(path): return false
	var relative := path.trim_prefix("res://")
	var components := relative.split("/")
	if components.is_empty() or components[0] in ["addons", ".git", ".godot"]: return false
	var lowered := path.to_lower()
	if "/.env" in lowered or "credential" in lowered or "secret" in lowered: return false
	var absolute := ProjectSettings.globalize_path(path).simplify_path()
	if not absolute.begins_with(project_root + "/"): return false
	var current := project_root
	for component in components:
		var directory := DirAccess.open(current)
		if directory != null and directory.is_link(component): return false
		current = current.path_join(component)
	return true

func _contains_nul(value: String) -> bool:
	for index in value.length():
		if value.unicode_at(index) == 0: return true
	return false

func _journal_path(path: String) -> String:
	var encoded := path.trim_prefix("res://").replace("/", "_")
	return project_root.path_join(".godot/godot-mcp/mutation-journal/%s/%s" % [action_id, encoded])

func _refresh() -> void:
	if editor_filesystem == null: return
	for step in prepared:
		for path in step.paths:
			if editor_filesystem.has_method("update_file"): editor_filesystem.update_file(path)

func _sha256(bytes: PackedByteArray) -> String:
	if bytes.is_empty(): return "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	var context := HashingContext.new()
	context.start(HashingContext.HASH_SHA256)
	context.update(bytes)
	return context.finish().hex_encode()

func _error(code: String, message: String) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": false}
