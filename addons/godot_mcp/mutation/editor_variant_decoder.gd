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
		"vector2i":
			if not _integer_fields(value, ["x", "y"]): return _error("INVALID_REQUEST", "Invalid Vector2i")
			return {"ok": true, "value": Vector2i(int(value.x), int(value.y))}
		"vector3i":
			if not _integer_fields(value, ["x", "y", "z"]): return _error("INVALID_REQUEST", "Invalid Vector3i")
			return {"ok": true, "value": Vector3i(int(value.x), int(value.y), int(value.z))}
		"vector4":
			if not _finite_fields(value, ["x", "y", "z", "w"]): return _error("INVALID_REQUEST", "Invalid Vector4")
			return {"ok": true, "value": Vector4(float(value.x), float(value.y), float(value.z), float(value.w))}
		"vector4i":
			if not _integer_fields(value, ["x", "y", "z", "w"]): return _error("INVALID_REQUEST", "Invalid Vector4i")
			return {"ok": true, "value": Vector4i(int(value.x), int(value.y), int(value.z), int(value.w))}
		"rect2":
			if not _finite_fields(value, ["x", "y", "width", "height"]): return _error("INVALID_REQUEST", "Invalid Rect2")
			return {"ok": true, "value": Rect2(float(value.x), float(value.y), float(value.width), float(value.height))}
		"rect2i":
			if not _integer_fields(value, ["x", "y", "width", "height"]): return _error("INVALID_REQUEST", "Invalid Rect2i")
			return {"ok": true, "value": Rect2i(int(value.x), int(value.y), int(value.width), int(value.height))}
		"color":
			if not _finite_fields(value, ["r", "g", "b", "a"]): return _error("INVALID_REQUEST", "Invalid Color")
			return {"ok": true, "value": Color(float(value.r), float(value.g), float(value.b), float(value.a))}
		"quaternion":
			if not _finite_fields(value, ["x", "y", "z", "w"]): return _error("INVALID_REQUEST", "Invalid Quaternion")
			return {"ok": true, "value": Quaternion(float(value.x), float(value.y), float(value.z), float(value.w))}
		"plane":
			if not _finite_fields(value, ["x", "y", "z", "d"]): return _error("INVALID_REQUEST", "Invalid Plane")
			return {"ok": true, "value": Plane(float(value.x), float(value.y), float(value.z), float(value.d))}
		"aabb":
			if value.size() != 3 or not _finite_array(value.get("position"), 3) or not _finite_array(value.get("size"), 3): return _error("INVALID_REQUEST", "Invalid AABB")
			return {"ok": true, "value": AABB(Vector3(value.position[0], value.position[1], value.position[2]), Vector3(value.size[0], value.size[1], value.size[2]))}
		"transform2d":
			if value.size() != 4 or not _finite_dictionary(value.get("x"), ["x", "y"]) or not _finite_dictionary(value.get("y"), ["x", "y"]) or not _finite_dictionary(value.get("origin"), ["x", "y"]): return _error("INVALID_REQUEST", "Invalid Transform2D")
			return {"ok": true, "value": Transform2D(_vector2(value.x), _vector2(value.y), _vector2(value.origin))}
		"basis":
			var basis := _basis(value)
			if basis == null: return _error("INVALID_REQUEST", "Invalid Basis")
			return {"ok": true, "value": basis}
		"transform3d":
			if value.size() != 3 or typeof(value.get("basis")) != TYPE_DICTIONARY or not _finite_dictionary(value.get("origin"), ["x", "y", "z"]): return _error("INVALID_REQUEST", "Invalid Transform3D")
			var transform_basis := _basis(value.basis, false)
			if transform_basis == null: return _error("INVALID_REQUEST", "Invalid Transform3D basis")
			return {"ok": true, "value": Transform3D(transform_basis, _vector3(value.origin))}
		"projection":
			if value.size() != 5: return _error("INVALID_REQUEST", "Invalid Projection")
			for name in ["x", "y", "z", "w"]:
				if not _finite_dictionary(value.get(name), ["x", "y", "z", "w"]): return _error("INVALID_REQUEST", "Invalid Projection column")
			return {"ok": true, "value": Projection(_vector4(value.x), _vector4(value.y), _vector4(value.z), _vector4(value.w))}
		"string_name":
			if value.size() != 2 or typeof(value.get("value")) != TYPE_STRING: return _error("INVALID_REQUEST", "Invalid StringName")
			return {"ok": true, "value": StringName(value.value)}
		"packed_byte_array": return _packed_numbers(value, TYPE_PACKED_BYTE_ARRAY)
		"packed_int32_array": return _packed_numbers(value, TYPE_PACKED_INT32_ARRAY)
		"packed_int64_array": return _packed_numbers(value, TYPE_PACKED_INT64_ARRAY)
		"packed_float32_array": return _packed_numbers(value, TYPE_PACKED_FLOAT32_ARRAY)
		"packed_float64_array": return _packed_numbers(value, TYPE_PACKED_FLOAT64_ARRAY)
		"packed_string_array":
			if not _bounded_values(value): return _error("PAYLOAD_TOO_LARGE", "Packed array exceeds 4096 entries")
			for item in value.values:
				if typeof(item) != TYPE_STRING: return _error("INVALID_REQUEST", "Packed string array contains a non-string")
			return {"ok": true, "value": PackedStringArray(value.values)}
		"packed_vector2_array": return _packed_vectors(value, 2)
		"packed_vector3_array": return _packed_vectors(value, 3)
		"packed_color_array": return _packed_colors(value)
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

static func _integer_fields(value: Dictionary, names: Array) -> bool:
	for name in names:
		if not value.has(name) or typeof(value[name]) != TYPE_INT: return false
	return value.size() == names.size() + 1

static func _finite_array(value: Variant, expected_size: int) -> bool:
	if typeof(value) != TYPE_ARRAY or value.size() != expected_size: return false
	for item in value:
		if typeof(item) not in [TYPE_INT, TYPE_FLOAT] or not is_finite(float(item)): return false
	return true

static func _finite_dictionary(value: Variant, names: Array) -> bool:
	if typeof(value) != TYPE_DICTIONARY or value.size() != names.size(): return false
	for name in names:
		if not value.has(name) or typeof(value[name]) not in [TYPE_INT, TYPE_FLOAT] or not is_finite(float(value[name])): return false
	return true

static func _vector2(value: Dictionary) -> Vector2:
	return Vector2(float(value.x), float(value.y))

static func _vector3(value: Dictionary) -> Vector3:
	return Vector3(float(value.x), float(value.y), float(value.z))

static func _vector4(value: Dictionary) -> Vector4:
	return Vector4(float(value.x), float(value.y), float(value.z), float(value.w))

static func _basis(value: Dictionary, tagged: bool = true) -> Variant:
	if value.size() != (4 if tagged else 3): return null
	if tagged and String(value.get("type", "")) != "basis": return null
	for name in ["x", "y", "z"]:
		if not _finite_dictionary(value.get(name), ["x", "y", "z"]): return null
	return Basis(_vector3(value.x), _vector3(value.y), _vector3(value.z))

static func _bounded_values(value: Dictionary) -> bool:
	return value.size() == 2 and typeof(value.get("values")) == TYPE_ARRAY and value.values.size() <= 4096

static func _packed_numbers(value: Dictionary, packed_type: int) -> Dictionary:
	if not _bounded_values(value): return _error("PAYLOAD_TOO_LARGE", "Packed array exceeds 4096 entries")
	for item in value.values:
		if typeof(item) not in [TYPE_INT, TYPE_FLOAT] or not is_finite(float(item)):
			return _error("INVALID_REQUEST", "Packed numeric array contains a non-finite number")
	match packed_type:
		TYPE_PACKED_BYTE_ARRAY: return {"ok": true, "value": PackedByteArray(value.values)}
		TYPE_PACKED_INT32_ARRAY: return {"ok": true, "value": PackedInt32Array(value.values)}
		TYPE_PACKED_INT64_ARRAY: return {"ok": true, "value": PackedInt64Array(value.values)}
		TYPE_PACKED_FLOAT32_ARRAY: return {"ok": true, "value": PackedFloat32Array(value.values)}
		TYPE_PACKED_FLOAT64_ARRAY: return {"ok": true, "value": PackedFloat64Array(value.values)}
	return _error("INVALID_REQUEST", "Unknown packed array type")

static func _packed_vectors(value: Dictionary, dimensions: int) -> Dictionary:
	if not _bounded_values(value): return _error("PAYLOAD_TOO_LARGE", "Packed vector array exceeds 4096 entries")
	var vectors: Array = []
	var names := ["x", "y"] if dimensions == 2 else ["x", "y", "z"]
	for item in value.values:
		if not _finite_dictionary(item, names): return _error("INVALID_REQUEST", "Packed vector array contains an invalid vector")
		vectors.append(_vector2(item) if dimensions == 2 else _vector3(item))
	return {"ok": true, "value": PackedVector2Array(vectors) if dimensions == 2 else PackedVector3Array(vectors)}

static func _packed_colors(value: Dictionary) -> Dictionary:
	if not _bounded_values(value): return _error("PAYLOAD_TOO_LARGE", "Packed color array exceeds 4096 entries")
	var colors: Array[Color] = []
	for item in value.values:
		if not _finite_dictionary(item, ["r", "g", "b", "a"]): return _error("INVALID_REQUEST", "Packed color array contains an invalid color")
		colors.append(Color(float(item.r), float(item.g), float(item.b), float(item.a)))
	return {"ok": true, "value": PackedColorArray(colors)}

static func _valid_node_path(path: String) -> bool:
	return not path.is_empty() and not path.begins_with("/") and ":" not in path and not _contains_nul(path) and ".." not in path.split("/")

static func _valid_resource_path(path: String) -> bool:
	if not path.begins_with("res://") or _contains_nul(path):
		return false
	var relative := path.trim_prefix("res://")
	if relative.is_empty() or ".." in relative.split("/"):
		return false
	return relative.get_slice("/", 0) not in ["addons", ".git", ".godot"]

static func _contains_nul(value: String) -> bool:
	for index in value.length():
		if value.unicode_at(index) == 0: return true
	return false

static func _error(code: String, message: String) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": false}
