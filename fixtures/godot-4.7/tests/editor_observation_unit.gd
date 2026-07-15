extends SceneTree

const DiagnosticLogger = preload("res://addons/godot_mcp/observation/diagnostic_logger.gd")
const MainThreadQueue = preload("res://addons/godot_mcp/commands/main_thread_queue.gd")
const VariantEncoder = preload("res://addons/godot_mcp/observation/variant_encoder.gd")
const CanonicalJson = preload("res://addons/godot_mcp/bridge/canonical_json.gd")
const EditorCapture = preload("res://addons/godot_mcp/observation/editor_capture.gd")

func _init() -> void:
	assert(CanonicalJson.encode({"limit": 20.0}) == "{\"limit\":20}")
	var chunks: Array[PackedByteArray] = EditorCapture.chunk_bytes(PackedByteArray([1, 2, 3, 4, 5]), 3)
	assert(chunks.size() == 2 and chunks[0].size() == 3 and chunks[1].size() == 2)
	var encoded: Variant = VariantEncoder.encode_value(Vector2(3, 4))
	assert(encoded == {"type": "Vector2", "x": "3.0", "y": "4.0"})
	var resource_value: Dictionary = VariantEncoder.encode_value(Resource.new())
	assert(resource_value.className == "Resource")

	var logger := DiagnosticLogger.new("/Users/example/secret-project")
	logger.record_for_test("error", "token=abc123 at /Users/example/secret-project/main.gd")
	var records: Array[Dictionary] = logger.read_after(0, ["error"], 10)
	assert(records.size() == 1)
	assert("abc123" not in JSON.stringify(records))
	assert("/Users/example" not in JSON.stringify(records))

	var queue := MainThreadQueue.new()
	for index in 33:
		var accepted: bool = queue.enqueue({
			"requestId": str(index),
			"deadlineUnixMs": 9999999999999,
			"method": "editor.query",
			"arguments": {},
		})
		assert(accepted == (index < 32))
	queue.free()
	logger = null

	print("GODOT_MCP_EDITOR_OBSERVATION_UNIT_OK")
	quit(0)
