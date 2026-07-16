extends SceneTree

const RuntimeDebugger = preload("res://addons/godot_mcp/runtime/runtime_debugger.gd")
const RuntimeHarness = preload("res://addons/godot_mcp/runtime/runtime_harness.gd")
const RuntimeCapture = preload("res://addons/godot_mcp/runtime/runtime_capture.gd")
const RuntimeControl = preload("res://addons/godot_mcp/runtime/runtime_control.gd")
const SessionCrypto = preload("res://addons/godot_mcp/bridge/session_crypto.gd")

func _init() -> void:
	assert(RuntimeHarness.descriptor_argument(PackedStringArray(["--other=x", "--godot-mcp-runtime-descriptor=/tmp/godot-mcp/runtime-a.json"])) == "/tmp/godot-mcp/runtime-a.json")
	assert(RuntimeHarness.descriptor_argument(PackedStringArray(["--godot-mcp-runtime-descriptor=a", "--godot-mcp-runtime-descriptor=b"])).is_empty())
	assert(RuntimeHarness.descriptor_path_is_allowed("/tmp/godot-mcp/runtime-a.json", "/tmp/godot-mcp"))
	assert(not RuntimeHarness.descriptor_path_is_allowed("/tmp/else/runtime-a.json", "/tmp/godot-mcp"))
	assert(RuntimeHarness.operation_is_allowed("tree"))
	assert(not RuntimeHarness.operation_is_allowed("eval"))
	var hello := {"runId": "run", "generation": 1, "projectId": "project", "sessionId": "session", "launchNonce": "nonce", "pid": 42, "proof": "client-proof"}
	assert(RuntimeHarness.hello_signing_text(hello) == RuntimeDebugger.hello_signing_text(hello))
	assert(RuntimeHarness.server_proof_signing_text(hello) == RuntimeDebugger.server_proof_signing_text(hello))
	var proof_key := PackedByteArray([1, 2, 3, 4])
	var server_proof := SessionCrypto.hmac_sha256(proof_key, RuntimeDebugger.server_proof_signing_text(hello)).hex_encode()
	assert(RuntimeHarness.valid_server_proof(proof_key, hello, server_proof))
	assert(not RuntimeHarness.valid_server_proof(proof_key, hello, "0".repeat(64)))
	assert(RuntimeHarness.owner_lease_path_is_allowed("/tmp/godot-mcp/runtime-a.lease", "/tmp/godot-mcp"))
	assert(not RuntimeHarness.owner_lease_path_is_allowed("/tmp/else/runtime-a.lease", "/tmp/godot-mcp"))
	assert(RuntimeHarness.owner_lease_is_fresh(100, 102000))
	assert(RuntimeHarness.owner_lease_is_fresh(100, 103999))
	assert(not RuntimeHarness.owner_lease_is_fresh(100, 104000))
	assert(RuntimeCapture.source_dimensions_allowed(4096, 4096))
	assert(not RuntimeCapture.source_dimensions_allowed(4097, 1))
	assert(not RuntimeCapture.source_dimensions_allowed(4096, 4097))
	assert(RuntimeControl.safe_property_pattern("^ready.*$"))
	assert(not RuntimeControl.safe_property_pattern("(a+)+$"))
	await process_frame
	var runtime_root := Node.new()
	root.add_child(runtime_root)
	paused = true
	var expired_step: Dictionary = await RuntimeControl.new(runtime_root, null, null).execute("step", {"frames": 1}, 1)
	assert(expired_step.get("code") == "TIMEOUT")
	assert(paused)
	paused = false
	var expired_capture: Dictionary = await RuntimeCapture.new(runtime_root, null).execute({"waitFrames": 1}, 1)
	assert(expired_capture.get("code") == "TIMEOUT")
	print("GODOT_MCP_RUNTIME_HARNESS_UNIT_OK")
	quit(0)
