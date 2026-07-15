@tool
class_name GodotMcpVariantEncoder
extends RefCounted

const MAX_DEPTH := 4
const MAX_ENTRIES := 128
const MAX_STRING_LENGTH := 4096
const SECRET_PATTERN := "(?i)(token|secret|password|authorization|cookie|api[_-]?key)\\s*[:=]\\s*[^\\s,;]+"
const HOST_PATH_PATTERN := "(?:/Users|/home)/[^\\s\"']+"

static func redact_text(value: String, project_root: String = "") -> String:
	var output := value
	if not project_root.is_empty():
		output = output.replace(project_root, "[redacted-path]")
	var secrets := RegEx.new()
	secrets.compile(SECRET_PATTERN)
	output = secrets.sub(output, "$1=[redacted]", true)
	var paths := RegEx.new()
	paths.compile(HOST_PATH_PATTERN)
	output = paths.sub(output, "[redacted-path]", true)
	return output.left(MAX_STRING_LENGTH)

static func encode_value(value: Variant, depth: int = 0) -> Variant:
	if depth > MAX_DEPTH:
		return {"truncated": true}
	match typeof(value):
		TYPE_NIL, TYPE_BOOL, TYPE_INT:
			return value
		TYPE_FLOAT:
			return {"type": "Float", "value": str(value)}
		TYPE_STRING, TYPE_STRING_NAME, TYPE_NODE_PATH:
			return redact_text(String(value))
		TYPE_VECTOR2:
			return {"type": "Vector2", "x": str(value.x), "y": str(value.y)}
		TYPE_VECTOR2I:
			return {"type": "Vector2i", "x": value.x, "y": value.y}
		TYPE_VECTOR3:
			return {"type": "Vector3", "x": str(value.x), "y": str(value.y), "z": str(value.z)}
		TYPE_VECTOR3I:
			return {"type": "Vector3i", "x": value.x, "y": value.y, "z": value.z}
		TYPE_VECTOR4:
			return {"type": "Vector4", "x": str(value.x), "y": str(value.y), "z": str(value.z), "w": str(value.w)}
		TYPE_COLOR:
			return {"type": "Color", "r": str(value.r), "g": str(value.g), "b": str(value.b), "a": str(value.a)}
		TYPE_RECT2:
			return {"type": "Rect2", "position": encode_value(value.position, depth + 1), "size": encode_value(value.size, depth + 1)}
		TYPE_AABB:
			return {"type": "AABB", "position": encode_value(value.position, depth + 1), "size": encode_value(value.size, depth + 1)}
		TYPE_TRANSFORM2D, TYPE_BASIS, TYPE_TRANSFORM3D, TYPE_QUATERNION, TYPE_PLANE:
			return {"type": type_string(typeof(value)), "value": String(value)}
		TYPE_ARRAY:
			var output: Array = []
			for index in mini(value.size(), MAX_ENTRIES):
				output.append(encode_value(value[index], depth + 1))
			if value.size() > MAX_ENTRIES:
				output.append({"truncated": true})
			return output
		TYPE_DICTIONARY:
			var output := {}
			var count := 0
			for key in value:
				if count >= MAX_ENTRIES:
					output["_truncated"] = true
					break
				var name := String(key)
				output[redact_text(name)] = "[redacted]" if _is_secret_name(name) else encode_value(value[key], depth + 1)
				count += 1
			return output
		TYPE_OBJECT:
			if value is Resource:
				var path := String(value.resource_path)
				var uid := ResourceUID.path_to_uid(path) if not path.is_empty() else ""
				return {"type": "ResourceRef", "className": value.get_class(), "path": path, "uid": uid}
			if value is Node:
				return {"type": "NodeRef", "className": value.get_class(), "nodePath": String(value.get_path()) if value.is_inside_tree() else String(value.name)}
	return {"type": type_string(typeof(value)), "unsupported": true}

static func _is_secret_name(name: String) -> bool:
	var normalized := name.to_lower()
	for marker in ["token", "secret", "password", "authorization", "cookie", "api_key", "api-key"]:
		if marker in normalized:
			return true
	return false
