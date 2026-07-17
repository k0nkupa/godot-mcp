@tool
class_name GodotMcpSourceAuthoring
extends RefCounted

const MAX_SOURCE_BYTES := 192 * 1024

static func prepare(step: Dictionary) -> Dictionary:
	var operation := String(step.get("operation", ""))
	if operation not in ["create_script", "replace_script", "create_shader", "replace_shader"]:
		return _error("INVALID_REQUEST", "Unsupported source authoring operation")
	var path := String(step.get("sourcePath", ""))
	var script_operation := operation.ends_with("script")
	if not _safe_path(path, ".gd" if script_operation else ".gdshader"):
		return _error("PATH_DENIED", "Source path is outside the project authoring surface")
	var content := String(step.get("content", "")).replace("\r\n", "\n").replace("\r", "\n")
	if _contains_nul(content): return _error("INVALID_REQUEST", "Source content contains a NUL byte")
	var bytes := content.to_utf8_buffer()
	if bytes.size() > MAX_SOURCE_BYTES: return _error("PAYLOAD_TOO_LARGE", "Source content exceeds 192 KiB")
	var exists := FileAccess.file_exists(path)
	if operation.begins_with("create_") and exists: return _error("CONFLICT", "Source destination already exists")
	if operation.begins_with("replace_") and not exists: return _error("TARGET_NOT_FOUND", "Source file was not found")
	var before_sha := _sha256(FileAccess.get_file_as_bytes(path)) if exists else ""
	if operation.begins_with("replace_") and String(step.get("expectedSha256", "")) != before_sha:
		return _error("PRECONDITION_FAILED", "Source file changed after preview")
	var parsed := _parse_script(content) if script_operation else _parse_shader(content)
	if not parsed.ok: return parsed
	return {
		"ok": true,
		"normalizedContent": content,
		"parseStatus": "valid",
		"diagnostics": [],
		"references": [],
		"prepared": {
			"_authoringKind": "source", "operation": operation, "path": path,
			"expectedExists": exists, "expectedSha256": before_sha, "desiredBytes": bytes,
		},
	}

static func _parse_script(content: String) -> Dictionary:
	var script := GDScript.new()
	script.source_code = content
	var result := script.reload()
	if result != OK: return _parse_error("GDScript source did not parse")
	return {"ok": true}

static func _parse_shader(content: String) -> Dictionary:
	var shader_type := RegEx.new()
	shader_type.compile("(?m)^\\s*shader_type\\s+(canvas_item|spatial|particles|sky|fog)\\s*;")
	if shader_type.search(content) == null or not _balanced(content): return _parse_error("Shader source did not parse")
	var shader := Shader.new()
	shader.code = content
	return {"ok": true}

static func _balanced(content: String) -> bool:
	var stack: Array[String] = []
	var pairs := {"}": "{", ")": "(", "]": "["}
	for index in content.length():
		var character := content.substr(index, 1)
		if character in ["{", "(", "["]: stack.append(character)
		elif pairs.has(character):
			if stack.is_empty() or stack.pop_back() != pairs[character]: return false
	return stack.is_empty()

static func _safe_path(path: String, extension: String) -> bool:
	if not path.begins_with("res://") or not path.ends_with(extension) or path.ends_with("/") or ".." in path.trim_prefix("res://").split("/") or _contains_nul(path): return false
	var components := path.trim_prefix("res://").split("/")
	if components.is_empty() or components[0].to_lower() in ["addons", ".godot", ".git"]: return false
	for component in components:
		if component.begins_with("."): return false
	var project_root := ProjectSettings.globalize_path("res://").simplify_path().trim_suffix("/")
	var absolute := ProjectSettings.globalize_path(path).simplify_path()
	if not absolute.begins_with(project_root + "/"): return false
	var current := project_root
	for component in components:
		var directory := DirAccess.open(current)
		if directory != null and directory.is_link(component): return false
		current = current.path_join(component)
	return true

static func _contains_nul(value: String) -> bool:
	for index in value.length():
		if value.unicode_at(index) in [0, 0xfffd]: return true
	return false

static func _sha256(bytes: PackedByteArray) -> String:
	if bytes.is_empty(): return "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	var context := HashingContext.new(); context.start(HashingContext.HASH_SHA256); context.update(bytes)
	return context.finish().hex_encode()

static func _parse_error(message: String) -> Dictionary:
	return {"ok": false, "code": "GODOT_PARSE_ERROR", "message": message, "retryable": false, "diagnostics": [{"severity": "error", "message": message}]}

static func _error(code: String, message: String) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": false}
