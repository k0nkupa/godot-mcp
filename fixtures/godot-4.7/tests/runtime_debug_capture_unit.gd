extends SceneTree

const RuntimeDebugCapture = preload("res://addons/godot_mcp/runtime/runtime_debug_capture.gd")

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
	print("PHASE7_DEBUG_CAPTURE_UNIT_OK")
	quit(0)
