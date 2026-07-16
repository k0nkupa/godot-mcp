@tool
class_name GodotMcpResourcePropertyAdapter
extends RefCounted

const ResourceLocator = preload("res://addons/godot_mcp/authoring/resource_locator.gd")
const VariantDecoder = preload("res://addons/godot_mcp/mutation/editor_variant_decoder.gd")
const VariantEncoder = preload("res://addons/godot_mcp/observation/variant_encoder.gd")

static func prepare(step_value: Dictionary, editor_filesystem: Variant) -> Dictionary:
	var step := step_value.duplicate(true)
	var located := ResourceLocator.resolve(step.get("target", {}), editor_filesystem)
	if not located.ok: return located
	var resource: Resource = located.resource
	var operation := String(step.get("operation", ""))
	step._resource = resource
	step._root = located.root
	step._identity = located.identity
	match operation:
		"set_resource_property":
			var property_name := String(step.get("property", ""))
			var property := _property(resource, property_name)
			if property.is_empty(): return _error("TARGET_NOT_FOUND", "Stored resource property was not found")
			if _denied_name(property_name): return _error("PATH_DENIED", "Resource property is outside the authoring surface")
			var decoded := VariantDecoder.decode(step.get("value"), editor_filesystem)
			if not decoded.ok: return decoded
			var compatible := _compatible(property, decoded.value)
			if not compatible.ok: return compatible
			step._before = resource.get(property_name); step._after = decoded.value
		"set_resource_metadata", "remove_resource_metadata":
			var key := String(step.get("key", ""))
			if key.is_empty() or VariantEncoder.is_secret_name(key): return _error("PATH_DENIED", "Resource metadata key is outside the authoring surface")
			step._had_before = resource.has_meta(key); step._before = resource.get_meta(key) if step._had_before else null
			if operation == "set_resource_metadata":
				var decoded := VariantDecoder.decode(step.get("value"), editor_filesystem)
				if not decoded.ok: return decoded
				step._after = decoded.value
		"assign_resource_reference":
			var property_name := String(step.get("property", ""))
			var property := _property(resource, property_name)
			if property.is_empty() or _denied_name(property_name): return _error("PATH_DENIED", "Resource reference property is outside the authoring surface")
			var decoded := VariantDecoder.decode({"type": "resource_ref", "path": step.get("referencePath", "")}, editor_filesystem)
			if not decoded.ok: return decoded
			var compatible := _compatible(property, decoded.value)
			if not compatible.ok: return compatible
			step._before = resource.get(property_name); step._after = decoded.value
		_: return _error("INVALID_REQUEST", "Unsupported resource authoring operation")
	return {"ok": true, "step": step, "identity": located.identity}

static func apply_step(step: Dictionary, forward: bool) -> void:
	var resource: Resource = step._resource
	match String(step.operation):
		"set_resource_property", "assign_resource_reference": resource.set(String(step.property), step._after if forward else step._before)
		"set_resource_metadata":
			if forward: resource.set_meta(String(step.key), step._after)
			elif step._had_before: resource.set_meta(String(step.key), step._before)
			else: resource.remove_meta(String(step.key))
		"remove_resource_metadata":
			if forward: resource.remove_meta(String(step.key))
			elif step._had_before: resource.set_meta(String(step.key), step._before)

static func _property(resource: Resource, property_name: String) -> Dictionary:
	for property in resource.get_property_list():
		if String(property.get("name", "")) == property_name and int(property.get("usage", 0)) & PROPERTY_USAGE_STORAGE != 0:
			return property
	return {}

static func _denied_name(property_name: String) -> bool:
	return property_name == "script" or property_name.begins_with("_") or VariantEncoder.is_secret_name(property_name)

static func _compatible(property: Dictionary, value: Variant) -> Dictionary:
	var expected := int(property.get("type", TYPE_NIL))
	var actual := typeof(value)
	if expected != actual and not (expected in [TYPE_INT, TYPE_FLOAT] and actual in [TYPE_INT, TYPE_FLOAT]):
		return _error("INVALID_REQUEST", "Resource property value type does not match")
	if expected == TYPE_OBJECT and value is Resource:
		var expected_class := String(property.get("class_name", property.get("hint_string", ""))).get_slice(",", 0)
		if not expected_class.is_empty() and not value.is_class(expected_class): return _error("INVALID_REQUEST", "Resource reference class does not match")
	return {"ok": true}

static func _error(code: String, message: String) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": false}
