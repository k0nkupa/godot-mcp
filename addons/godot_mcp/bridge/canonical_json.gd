@tool
class_name GodotMcpCanonicalJson
extends RefCounted

const MAX_SAFE_INTEGER := 9007199254740991

static func encode(value: Variant) -> String:
	var result := _encode_value(value)
	if not result.ok:
		push_error("Godot MCP canonical JSON rejected value: %s" % result.error)
		return ""
	return result.text

static func _success(text: String) -> Dictionary:
	return {"ok": true, "text": text, "error": ""}

static func _failure(message: String) -> Dictionary:
	return {"ok": false, "text": "", "error": message}

static func _encode_value(value: Variant) -> Dictionary:
	match typeof(value):
		TYPE_NIL:
			return _success("null")
		TYPE_BOOL:
			return _success("true" if value else "false")
		TYPE_STRING, TYPE_STRING_NAME:
			return _success(JSON.stringify(String(value)))
		TYPE_INT:
			if value < -MAX_SAFE_INTEGER or value > MAX_SAFE_INTEGER:
				return _failure("integer outside the safe range")
			return _success(str(value))
		TYPE_FLOAT:
			return _failure("floating-point values require tagged strings in protocol v1")
		TYPE_ARRAY:
			var items: Array[String] = []
			for item in value:
				var encoded := _encode_value(item)
				if not encoded.ok:
					return encoded
				items.append(encoded.text)
			return _success("[" + ",".join(items) + "]")
		TYPE_DICTIONARY:
			var keys: Array[String] = []
			for key in value.keys():
				if typeof(key) != TYPE_STRING and typeof(key) != TYPE_STRING_NAME:
					return _failure("dictionary keys must be strings")
				keys.append(String(key))
			keys.sort()
			var fields: Array[String] = []
			for key in keys:
				var encoded := _encode_value(value[key])
				if not encoded.ok:
					return encoded
				fields.append(JSON.stringify(key) + ":" + encoded.text)
			return _success("{" + ",".join(fields) + "}")
		_:
			return _failure("unsupported Variant type %s" % typeof(value))
