extends SceneTree

const RuntimeDebugger = preload("res://addons/godot_mcp/runtime/runtime_debugger.gd")
const RuntimeHarness = preload("res://addons/godot_mcp/runtime/runtime_harness.gd")

func _init() -> void:
	assert(RuntimeHarness.descriptor_argument(PackedStringArray(["--other=x", "--godot-mcp-runtime-descriptor=/tmp/godot-mcp/runtime-a.json"])) == "/tmp/godot-mcp/runtime-a.json")
	assert(RuntimeHarness.descriptor_argument(PackedStringArray(["--godot-mcp-runtime-descriptor=a", "--godot-mcp-runtime-descriptor=b"])).is_empty())
	assert(RuntimeHarness.descriptor_path_is_allowed("/tmp/godot-mcp/runtime-a.json", "/tmp/godot-mcp"))
	assert(not RuntimeHarness.descriptor_path_is_allowed("/tmp/else/runtime-a.json", "/tmp/godot-mcp"))
	assert(RuntimeHarness.operation_is_allowed("tree"))
	assert(not RuntimeHarness.operation_is_allowed("eval"))
	var hello := {"runId": "run", "generation": 1, "projectId": "project", "sessionId": "session", "launchNonce": "nonce", "pid": 42}
	assert(RuntimeHarness.hello_signing_text(hello) == RuntimeDebugger.hello_signing_text(hello))
	print("GODOT_MCP_RUNTIME_HARNESS_UNIT_OK")
	quit(0)
