@tool
class_name GodotMcpEditorVariantDecoder
extends RefCounted

const MAX_DEPTH := 8
const MAX_ENTRIES := 256
const MAX_STRING_BYTES := 16384

static func decode(value: Variant, editor_filesystem: Variant = null, depth: int = 0) -> Dictionary:
	if depth > MAX_DEPTH:
		return _error("PAYLOAD_TOO_LARGE", "Editor Variant exceeds depth 8")
	match typeof(value):
		TYPE_NIL, TYPE_BOOL, TYPE_INT:
			return {"ok": true, "value": value}
		TYPE_FLOAT:
			if not is_finite(value):
				return _error("INVALID_REQUEST", "Editor Variant number must be finite")
			return {"ok": true, "value": value}
		TYPE_STRING, TYPE_STRING_NAME:
			if String(value).to_utf8_buffer().size() > MAX_STRING_BYTES:
				return _error("PAYLOAD_TOO_LARGE", "Editor Variant string exceeds 16 KiB")
			return {"ok": true, "value": String(value)}
		TYPE_ARRAY:
			if value.size() > MAX_ENTRIES:
				return _error("PAYLOAD_TOO_LARGE", "Editor Variant array exceeds 256 entries")
			var array: Array = []
			for item in value:
				var decoded := decode(item, editor_filesystem, depth + 1)
				if not decoded.ok:
					return decoded
				array.append(decoded.value)
			return {"ok": true, "value": array}
		TYPE_DICTIONARY:
			if value.size() > MAX_ENTRIES:
				return _error("PAYLOAD_TOO_LARGE", "Editor Variant dictionary exceeds 256 entries")
			if value.has("type"):
				return _decode_tagged(value, editor_filesystem)
			var dictionary := {}
			for key in value:
				if typeof(key) != TYPE_STRING and typeof(key) != TYPE_STRING_NAME:
					return _error("INVALID_REQUEST", "Editor Variant dictionary keys must be strings")
				var decoded := decode(value[key], editor_filesystem, depth + 1)
				if not decoded.ok:
					return decoded
				dictionary[String(key)] = decoded.value
			return {"ok": true, "value": dictionary}
	return _error("INVALID_REQUEST", "Unsupported editor Variant type")

static func _decode_tagged(value: Dictionary, editor_filesystem: Variant) -> Dictionary:
	var tag := String(value.get("type", ""))
	match tag:
		"vector2":
			if not _finite_fields(value, ["x", "y"]): return _error("INVALID_REQUEST", "Invalid Vector2")
			return {"ok": true, "value": Vector2(float(value.x), float(value.y))}
		"vector3":
			if not _finite_fields(value, ["x", "y", "z"]): return _error("INVALID_REQUEST", "Invalid Vector3")
			return {"ok": true, "value": Vector3(float(value.x), float(value.y), float(value.z))}
		"color":
			if not _finite_fields(value, ["r", "g", "b", "a"]): return _error("INVALID_REQUEST", "Invalid Color")
			return {"ok": true, "value": Color(float(value.r), float(value.g), float(value.b), float(value.a))}
		"node_path":
			var path := String(value.get("value", ""))
			if not _valid_node_path(path): return _error("INVALID_REQUEST", "Invalid NodePath Variant")
			return {"ok": true, "value": NodePath(path)}
		"resource_ref":
			var path := String(value.get("path", ""))
			if not _valid_resource_path(path) or not ResourceLoader.exists(path):
				return _error("TARGET_NOT_FOUND", "Resource reference is not an indexed project resource")
			if editor_filesystem != null and editor_filesystem.has_method("get_file_type") and String(editor_filesystem.get_file_type(path)).is_empty():
				return _error("TARGET_NOT_FOUND", "Resource reference is not indexed by the editor")
			var resource := ResourceLoader.load(path)
			if resource == null or resource is Script:
				return _error("PATH_DENIED", "Script resources are not valid Phase 5 property references")
			return {"ok": true, "value": resource}
	return _error("INVALID_REQUEST", "Unknown tagged editor Variant")

static func _finite_fields(value: Dictionary, names: Array) -> bool:
	for name in names:
		if not value.has(name) or typeof(value[name]) not in [TYPE_INT, TYPE_FLOAT] or not is_finite(float(value[name])):
			return false
	return value.size() == names.size() + 1

static func _valid_node_path(path: String) -> bool:
	return not path.is_empty() and not path.begins_with("/") and ":" not in path and not _contains_nul(path) and ".." not in path.split("/")

static func _valid_resource_path(path: String) -> bool:
	return path.begins_with("res://") and (path.ends_with(".tres") or path.ends_with(".res")) and ".." not in path.trim_prefix("res://").split("/") and not _contains_nul(path)

static func _contains_nul(value: String) -> bool:
	for index in value.length():
		if value.unicode_at(index) == 0: return true
	return false

static func _error(code: String, message: String) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": false}
