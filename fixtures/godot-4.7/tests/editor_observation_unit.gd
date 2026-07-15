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
	logger.record_for_test("error", "Authorization: Bearer header-secret")
	logger.record_for_test("error", "failure at /private/tmp/host-only.log")
	logger.record_for_test("error", "mounted asset /Volumes/External/private.png")
	logger.record_for_test("error", "tool path=/opt/homebrew/bin/godot")
	var records: Array[Dictionary] = logger.read_after(0, ["error"], 10)
	assert(records.size() == 5)
	assert("abc123" not in JSON.stringify(records))
	assert("header-secret" not in JSON.stringify(records))
	assert("/Users/example" not in JSON.stringify(records))
	assert("/private/tmp" not in JSON.stringify(records))
	assert("/Volumes/External" not in JSON.stringify(records))
	assert("/opt/homebrew" not in JSON.stringify(records))

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
	var expired_queue := MainThreadQueue.new()
	get_root().add_child(expired_queue)
	var expired_codes: Array[String] = []
	expired_queue.failed.connect(func(_request_id: String, code: String, _message: String, _retryable: bool) -> void: expired_codes.append(code))
	assert(expired_queue.enqueue({"requestId": "expired", "deadlineUnixMs": 1, "method": "editor.query", "arguments": {}}))
	expired_queue._run_next()
	assert(expired_codes == ["TIMEOUT"])
	expired_queue.queue_free()
	var serialized_queue := MainThreadQueue.new()
	get_root().add_child(serialized_queue)
	var activity := [0, 0, 0]
	serialized_queue.set_handler(func(_command: Dictionary) -> Dictionary:
		activity[0] += 1
		activity[1] = maxi(activity[1], activity[0])
		await process_frame
		activity[0] -= 1
		activity[2] += 1
		return {"ok": true}
	)
	assert(serialized_queue.enqueue({"requestId": "first", "deadlineUnixMs": 9999999999999}))
	assert(serialized_queue.enqueue({"requestId": "second", "deadlineUnixMs": 9999999999999}))
	serialized_queue._run_next()
	for _frame in 60:
		if activity[2] == 2:
			break
		await process_frame
	assert(activity[1] == 1 and activity[2] == 2)
	serialized_queue.queue_free()
	logger = null

	print("GODOT_MCP_EDITOR_OBSERVATION_UNIT_OK")
	quit(0)
