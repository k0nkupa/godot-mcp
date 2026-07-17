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
	var huge_bounded: Dictionary = capture._bounded_text("x".repeat(1_000_000))
	assert(huge_bounded.text.length() == RuntimeDebugCapture.MAX_TEXT_BYTES)
	assert(huge_bounded.truncated)

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
	var oversized_key := "k".repeat(10_000)
	var oversized_parent: Dictionary = capture._variable("oversized_key", {
		oversized_key: "value",
		-1: "negative",
		1.5: "float",
		1_000_001: "too-large",
		"": "empty",
	})
	var oversized_children: Dictionary = capture.children(int(oversized_parent.variablesReference), 0, 10)
	assert(oversized_children.ok and oversized_children.data.body.variables.size() == 5)
	for child: Dictionary in oversized_children.data.body.variables:
		assert(child.selectorKind == "unsupported")
		assert(not child.has("selectorValue"))
		assert(String(child.name).length() <= 128)
		for name_index in String(child.name).length():
			assert(String(child.name).unicode_at(name_index) != 0)

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
	var freed_object := Node.new()
	freed_object.free()
	assert(capture._display_value(freed_object) == "<freed Object>")
	assert(capture._unsupported_key_name(freed_object) == "<freed Object>")

	capture._frames = [{"id": 0, "name": "cached", "source": {"path": "res://cached.gd"}, "line": 1, "column": 0}]
	capture._references[77] = ["stable"]
	var cached_stack: Dictionary = capture.stack(0, 64)
	assert(cached_stack.ok and cached_stack.data.body.stackFrames[0].name == "cached")
	assert(capture._references.has(77) and capture._references[77] == ["stable"])
	capture._frame_scopes = [{
		"locals": [capture._variable("kept", 1)],
		"members": [],
		"localsTruncated": true,
		"membersTruncated": false,
	}]
	capture._globals = [capture._variable("global", 1)]
	capture._globals_truncated = true
	var clipped_locals: Dictionary = capture.variables(0, "locals", 0, 256)
	assert(clipped_locals.ok and clipped_locals.data.body.variables.size() == 1)
	assert(clipped_locals.data.body.truncated)
	var clipped_globals: Dictionary = capture.variables(0, "globals", 0, 256)
	assert(clipped_globals.ok and clipped_globals.data.body.truncated)
	print("PHASE7_DEBUG_CAPTURE_UNIT_OK")
	quit(0)
