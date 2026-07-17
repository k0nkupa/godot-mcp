@tool
class_name GodotMcpCustomResourceAuthoring
extends RefCounted

static func prepare(step: Dictionary, context: Dictionary) -> Dictionary:
	var registry: Dictionary = context.get("classRegistry", {})
	var class_name_value := String(step.get("className", ""))
	if not registry.has(class_name_value): return _error("TARGET_NOT_FOUND", "Custom Resource class is not registered")
	var descriptor: Dictionary = registry[class_name_value]
	if String(descriptor.get("base", "")) != "Resource": return _error("PATH_DENIED", "Registered class is not a Resource")
	var exports: Dictionary = descriptor.get("exports", {})
	var properties: Dictionary = step.get("properties", {})
	for name in properties:
		if not exports.has(name): return _error("INVALID_REQUEST", "Custom Resource property is not an exported stored property")
	var lines := [
		"[gd_resource type=\"Resource\" script_class=\"%s\" load_steps=2 format=3]" % class_name_value,
		"", "[ext_resource type=\"Script\" path=\"%s\" id=\"1_script\"]" % String(descriptor.scriptPath),
		"", "[resource]", "script = ExtResource(\"1_script\")",
	]
	var names: Array = properties.keys(); names.sort()
	for name in names:
		var encoded := _encode(properties[name])
		if not encoded.ok: return encoded
		lines.append("%s = %s" % [name, encoded.value])
	var bytes := ("\n".join(lines) + "\n").to_utf8_buffer()
	return {"ok": true, "prepared": {"_authoringKind": "custom_resource", "operation": "create_custom_resource", "path": String(step.resourcePath), "expectedExists": false, "expectedSha256": "", "desiredBytes": bytes}}

static func _encode(value: Variant) -> Dictionary:
	match typeof(value):
		TYPE_NIL: return {"ok": true, "value": "null"}
		TYPE_BOOL: return {"ok": true, "value": "true" if value else "false"}
		TYPE_INT, TYPE_FLOAT: return {"ok": true, "value": str(value)}
		TYPE_STRING: return {"ok": true, "value": '"%s"' % String(value).c_escape()}
	return _error("INVALID_REQUEST", "Custom Resource property type is not structurally serializable")

static func _error(code: String, message: String) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": false}
