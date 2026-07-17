extends SceneTree

const RuntimeDebugCapture = preload("res://addons/godot_mcp/runtime/runtime_debug_capture.gd")

class SideEffectKey extends RefCounted:
	var string_calls := 0

	func _to_string() -> String:
		string_calls += 1
		return "unsafe-object-key"

func _init() -> void:
	var capture := RuntimeDebugCapture.new()
	var packed := PackedByteArray()
	packed.resize(2_000_000)
	var packed_value: Dictionary = capture._variable("buffer", packed)
	assert(packed_value.value == "PackedByteArray(size=2000000)")
	assert(not packed_value.valueTruncated)

	var bounded: Dictionary = capture._variable("message", "界".repeat(2_000))
	assert(bounded.value.to_utf8_buffer().size() <= RuntimeDebugCapture.MAX_TEXT_BYTES)
	assert(bounded.valueTruncated)
	assert(not capture._variable("small", "complete").valueTruncated)

	var dictionary := {0: "numeric", "0": "string"}
	var parent: Dictionary = capture._variable("container", dictionary)
	var children: Dictionary = capture.children(int(parent.variablesReference), 0, 10)
	assert(children.ok)
	var saw_number := false
	var saw_string := false
	for child: Dictionary in children.data.body.variables:
		if child.selectorKind == "number" and child.selectorValue == 0:
			saw_number = true
		if child.selectorKind == "string" and child.selectorValue == "0":
			saw_string = true
	assert(saw_number and saw_string)

	var long_secret_name := "x".repeat(140) + "_token"
	var redacted: Dictionary = capture._variable(long_secret_name, "must-not-escape")
	assert(redacted.value == "[redacted]")
	assert(redacted.name.length() == 128)

	var object_key := SideEffectKey.new()
	var object_parent: Dictionary = capture._variable("objects", {object_key: "value"})
	var object_children: Dictionary = capture.children(int(object_parent.variablesReference), 0, 10)
	assert(object_children.ok and object_children.data.body.variables.size() == 1)
	assert(object_key.string_calls == 0)
	assert(String(object_children.data.body.variables[0].name).begins_with("<RefCounted#"))

	capture._frames = [{"id": 0, "name": "cached", "source": {"path": "res://cached.gd"}, "line": 1, "column": 0}]
	capture._references[77] = ["stable"]
	var cached_stack: Dictionary = capture.stack(0, 64)
	assert(cached_stack.ok and cached_stack.data.body.stackFrames[0].name == "cached")
	assert(capture._references.has(77) and capture._references[77] == ["stable"])
	print("PHASE7_DEBUG_CAPTURE_UNIT_OK")
	quit(0)
