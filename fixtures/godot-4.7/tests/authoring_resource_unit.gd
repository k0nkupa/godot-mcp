extends SceneTree

const VariantDecoder = preload("res://addons/godot_mcp/mutation/editor_variant_decoder.gd")
const VariantEncoder = preload("res://addons/godot_mcp/observation/variant_encoder.gd")
const ResourceLocator = preload("res://addons/godot_mcp/authoring/resource_locator.gd")
const PropertyAdapter = preload("res://addons/godot_mcp/authoring/resource_property_adapter.gd")

var _failed := false

func _init() -> void:
	var decoded := VariantDecoder.decode({"type": "vector2i", "x": 3, "y": 4})
	_expect(decoded.ok and decoded.value == Vector2i(3, 4))
	_expect(VariantDecoder.decode({"type": "rect2", "x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0}).value == Rect2(1, 2, 3, 4))
	_expect(VariantDecoder.decode({"type": "packed_int32_array", "values": [1, 2, 3]}).value == PackedInt32Array([1, 2, 3]))
	_expect(VariantDecoder.decode({"type": "transform2d", "x": {"x": 1.0, "y": 0.0}, "y": {"x": 0.0, "y": 1.0}, "origin": {"x": 4.0, "y": 5.0}}).value == Transform2D(Vector2(1, 0), Vector2(0, 1), Vector2(4, 5)))
	_expect(VariantDecoder.decode({"type": "packed_vector2_array", "values": [{"x": 1.0, "y": 2.0}, {"x": 3.0, "y": 4.0}]}).value == PackedVector2Array([Vector2(1, 2), Vector2(3, 4)]))
	_expect(not VariantDecoder.decode({"type": "packed_float32_array", "values": [NAN]}).ok)
	_expect(VariantEncoder.encode_value(Vector2i(3, 4)).type == "Vector2i")
	var encoded_packed: Dictionary = VariantEncoder.encode_value(PackedInt32Array([1, 2, 3]))
	_expect(encoded_packed.type == "PackedInt32Array" and encoded_packed.values == [1, 2, 3] and not encoded_packed.has("unsupported"))

	var located := ResourceLocator.resolve({
		"resourcePath": "res://mutation/fixture_resource.tres",
		"propertyPath": [],
	}, null)
	_expect(located.ok and located.resource is Resource)
	_expect(String(located.identity.revision).length() == 64)

	var prepared := PropertyAdapter.prepare({
		"operation": "set_resource_property",
		"target": {"resourcePath": "res://mutation/fixture_resource.tres", "propertyPath": []},
		"property": "resource_name",
		"value": "phase-6-resource",
	}, null)
	_expect(prepared.ok)
	_expect(prepared.step._before == "phase-5-fixture")
	_expect(prepared.step._after == "phase-6-resource")
	PropertyAdapter.apply_step(prepared.step, true)
	_expect(prepared.step._resource.resource_name == "phase-6-resource")
	PropertyAdapter.apply_step(prepared.step, false)
	_expect(prepared.step._resource.resource_name == "phase-5-fixture")

	var denied := PropertyAdapter.prepare({
		"operation": "set_resource_property",
		"target": {"resourcePath": "res://mutation/fixture_resource.tres", "propertyPath": []},
		"property": "script",
		"value": null,
	}, null)
	_expect(not denied.ok and denied.code == "PATH_DENIED")

	var missing := ResourceLocator.resolve({"resourcePath": "res://missing.tres", "propertyPath": []}, null)
	_expect(not missing.ok and missing.code == "TARGET_NOT_FOUND")
	if not _failed: print("PHASE6_RESOURCE_UNIT_OK")
	quit(1 if _failed else 0)

func _expect(condition: bool) -> void:
	if not condition:
		_failed = true
		push_error("Phase 6 resource unit expectation failed")
