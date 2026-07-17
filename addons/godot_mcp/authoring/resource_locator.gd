@tool
class_name GodotMcpResourceLocator
extends RefCounted

const CanonicalJson = preload("res://addons/godot_mcp/bridge/canonical_json.gd")
const VariantEncoder = preload("res://addons/godot_mcp/observation/variant_encoder.gd")

static func resolve(locator: Dictionary, editor_filesystem: Variant, root_override: Resource = null) -> Dictionary:
	var path := String(locator.get("resourcePath", ""))
	if not _valid_path(path): return _error("PATH_DENIED", "Resource path is outside the project authoring surface")
	if editor_filesystem != null and editor_filesystem.has_method("get_file_type") and String(editor_filesystem.get_file_type(path)).is_empty():
		return _error("TARGET_NOT_FOUND", "Resource is not indexed by the editor")
	if not ResourceLoader.exists(path): return _error("TARGET_NOT_FOUND", "Resource was not found")
	var root := root_override if root_override != null else ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
	if root == null or root is Script: return _error("PATH_DENIED", "Resource target is not authorable")
	var current: Resource = root
	var property_path: Array = locator.get("propertyPath", [])
	if property_path.size() > 8: return _error("PAYLOAD_TOO_LARGE", "Embedded resource path exceeds depth 8")
	for segment_value in property_path:
		var segment := String(segment_value)
		if not _stored_property(current, segment): return _error("TARGET_NOT_FOUND", "Embedded resource property was not found")
		var child: Variant = current.get(segment)
		if not child is Resource or child is Script: return _error("TARGET_NOT_FOUND", "Embedded resource target was not found")
		current = child
	var revision := _revision(path, property_path, current)
	return {"ok": true, "resource": current, "root": root, "identity": {"kind": "resource", "path": _identity_path(path, property_path), "revision": revision}, "revision": revision}

static func _stored_property(resource: Resource, property_name: String) -> bool:
	for property in resource.get_property_list():
		if String(property.get("name", "")) == property_name and int(property.get("usage", 0)) & PROPERTY_USAGE_STORAGE != 0:
			return true
	return false

static func _revision(path: String, property_path: Array, resource: Resource) -> String:
	var properties: Array[Dictionary] = []
	for property in resource.get_property_list():
		if int(property.get("usage", 0)) & PROPERTY_USAGE_STORAGE == 0: continue
		var name := String(property.get("name", ""))
		properties.append({"name": name, "value": "[redacted]" if VariantEncoder.is_secret_name(name) else VariantEncoder.encode_value(resource.get(name))})
	properties.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return String(a.name) < String(b.name))
	return _sha256(CanonicalJson.encode({"path": path, "uid": ResourceUID.path_to_uid(path), "propertyPath": property_path, "class": resource.get_class(), "properties": properties}))

static func _identity_path(path: String, property_path: Array) -> String:
	return path if property_path.is_empty() else "%s::%s" % [path, "/".join(property_path)]

static func _valid_path(path: String) -> bool:
	if not path.begins_with("res://") or path.ends_with("/") or ".." in path.trim_prefix("res://").split("/") or _contains_nul(path): return false
	var first := path.trim_prefix("res://").get_slice("/", 0).to_lower()
	return first not in ["addons", ".godot", ".git"] and not path.ends_with(".gd") and not path.ends_with(".gdshader")

static func _contains_nul(value: String) -> bool:
	for index in value.length():
		if value.unicode_at(index) == 0: return true
	return false

static func _sha256(value: String) -> String:
	var context := HashingContext.new(); context.start(HashingContext.HASH_SHA256); context.update(value.to_utf8_buffer())
	return context.finish().hex_encode()

static func _error(code: String, message: String) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": false}
