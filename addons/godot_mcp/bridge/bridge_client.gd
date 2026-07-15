@tool
class_name GodotMcpBridgeClient
extends Node

const DescriptorReader = preload("res://addons/godot_mcp/bridge/descriptor_reader.gd")
const ProtocolConstants = preload("res://addons/godot_mcp/generated/protocol_constants.gd")
const SessionCrypto = preload("res://addons/godot_mcp/bridge/session_crypto.gd")
const OUTBOUND_BUFFER_BYTES := 1024 * 1024
const OUTBOUND_DRAIN_TARGET_BYTES := 128 * 1024

signal attached(session_info: Dictionary)
signal rejected(code: String, message: String)
signal disconnected(reason: String)
signal command_received(command: Dictionary)

var _identity: Dictionary = {}
var _descriptor: Dictionary = {}
var _socket: WebSocketPeer
var _closed := true
var _paired := false
var _pair_sent := false
var _last_attempted_nonce := ""
var _next_descriptor_check_ms := 0
var _session_id := ""
var _session_key := PackedByteArray()
var _token_bytes := PackedByteArray()
var _send_sequence := 0
var _receive_sequence := 0

func _godot_version() -> String:
	var info := Engine.get_version_info()
	return "%s.%s.%s.%s" % [info.major, info.minor, info.status, info.build]

func start(project_identity: Dictionary) -> void:
	_identity = project_identity
	_closed = false
	set_process(true)

func _process(_delta: float) -> void:
	if _closed:
		return
	if _socket == null:
		if Time.get_ticks_msec() >= _next_descriptor_check_ms:
			_try_descriptor()
		return
	_socket.poll()
	var state := _socket.get_ready_state()
	if state == WebSocketPeer.STATE_OPEN and not _pair_sent:
		_send_pair_request()
	while _socket != null and _socket.get_available_packet_count() > 0:
		var packet := _socket.get_packet()
		if not _socket.was_string_packet():
			close("binary_frame_rejected")
			return
		_handle_message(packet.get_string_from_utf8())
	if state == WebSocketPeer.STATE_CLOSED:
		_socket = null
		_pair_sent = false
		if _paired:
			_paired = false
			disconnected.emit("socket_closed")

func _try_descriptor() -> void:
	_next_descriptor_check_ms = Time.get_ticks_msec() + 250
	var descriptor := DescriptorReader.read_for_project(_identity)
	if descriptor.is_empty() or descriptor.sessionNonce == _last_attempted_nonce:
		return
	_last_attempted_nonce = descriptor.sessionNonce
	_descriptor = descriptor
	_socket = WebSocketPeer.new()
	_socket.outbound_buffer_size = OUTBOUND_BUFFER_BYTES
	var error := _socket.connect_to_url("ws://127.0.0.1:%s/bridge" % int(descriptor.port))
	if error != OK:
		_socket = null
		rejected.emit("AUTHENTICATION_FAILED", "Could not connect to the loopback bridge")

func _addon_manifest_hash() -> String:
	var path := ProjectSettings.globalize_path("res://.godot/godot-mcp/install-manifest.json")
	if not FileAccess.file_exists(path):
		return ""
	var manifest := JSON.parse_string(FileAccess.get_file_as_string(path))
	if typeof(manifest) != TYPE_DICTIONARY:
		return ""
	return String(manifest.get("manifestSha256", ""))

func _send_pair_request() -> void:
	_pair_sent = true
	_token_bytes = SessionCrypto.base64url_decode(_descriptor.token)
	_socket.send_text(JSON.stringify({
		"method": "pair",
		"token": _descriptor.token,
		"sessionNonce": _descriptor.sessionNonce,
		"protocolVersion": ProtocolConstants.BRIDGE_PROTOCOL_VERSION,
		"productVersion": ProtocolConstants.PRODUCT_VERSION,
		"project": _identity,
		"addonManifestSha256": _addon_manifest_hash(),
		"godotVersion": _godot_version(),
	}))

func _handle_message(text: String) -> void:
	var message := JSON.parse_string(text)
	if typeof(message) != TYPE_DICTIONARY:
		close("malformed_json")
		return
	if not _paired and message.get("method") == "pair_rejected":
		rejected.emit(String(message.get("code", "AUTHENTICATION_FAILED")), String(message.get("message", "Pairing rejected")))
		close("pair_rejected")
		return
	if _session_key.is_empty():
		_handle_pair_ok(message)
		return
	if not SessionCrypto.verify_envelope(
		message, _session_key, _receive_sequence, _session_id
	):
		close("invalid_signed_envelope")
		return
	_receive_sequence = int(message.sequence)
	if not _paired and message.method == "pair.complete":
		_complete_pairing()
		return
	if message.method in ["editor.query", "editor.capture", "runtime.prepare", "runtime.command", "runtime.capture", "runtime.cleanup"]:
		var params: Variant = message.params
		if typeof(params) != TYPE_DICTIONARY or not params.has("requestId") or typeof(params.get("arguments")) != TYPE_DICTIONARY:
			rejected.emit("INVALID_REQUEST", "Bridge command parameters are invalid")
			return
		command_received.emit({"requestId": String(params.requestId), "deadlineUnixMs": int(message.deadlineUnixMs), "method": String(message.method), "arguments": params.arguments})
		return
	rejected.emit("INVALID_REQUEST", "Unsupported bridge command")

func _handle_pair_ok(message: Dictionary) -> void:
	for field in ["sessionId", "serverNonce", "serverProof", "grants"]:
		if not message.has(field):
			close("invalid_pair_response")
			return
	var expected_proof := SessionCrypto.server_proof(
		_descriptor.token,
		message.sessionId,
		message.serverNonce
	)
	if not SessionCrypto.constant_time_equal(expected_proof, message.serverProof):
		close("invalid_server_proof")
		return
	_session_id = message.sessionId
	_session_key = SessionCrypto.derive_key(
		_descriptor.token,
		_descriptor.sessionNonce,
		message.serverNonce
	)
	_send_signed("pair.ack", {"serverProof": expected_proof}, 5000)

func _complete_pairing() -> void:
	_paired = true
	DescriptorReader.delete_descriptor(_descriptor.descriptorPath)
	_token_bytes.fill(0)
	_token_bytes = PackedByteArray()
	_descriptor.token = ""
	var session_info := {
		"sessionId": _session_id,
		"project": _identity,
		"godotVersion": _godot_version(),
		"addonManifestSha256": _addon_manifest_hash(),
	}
	attached.emit(session_info)
	var configured_features := ProjectSettings.get_setting(
		"application/config/features", PackedStringArray()
	) as PackedStringArray
	var feature_tags: Array[String] = []
	for feature in configured_features:
		feature_tags.append(feature)
	_send_signed("addon.ready", {
		"project": _identity,
		"godotVersion": _godot_version(),
		"featureTags": feature_tags,
		"addonManifestSha256": _addon_manifest_hash(),
		"pluginEnabled": true,
	}, 30000)

func _send_signed(method: String, params: Variant, timeout_ms: int) -> Error:
	_send_sequence += 1
	var envelope := {
		"sessionId": _session_id,
		"sequence": _send_sequence,
		"deadlineUnixMs": int(Time.get_unix_time_from_system() * 1000.0) + timeout_ms,
		"method": method,
		"params": params,
	}
	return _socket.send_text(JSON.stringify(SessionCrypto.sign_envelope(envelope, _session_key)))

func is_attached() -> bool:
	return _paired and _socket != null and _socket.get_ready_state() == WebSocketPeer.STATE_OPEN

func send_command_result(request_id: String, data: Dictionary, binary: Dictionary = {}, deadline_unix_ms: int = 0) -> void:
	if is_attached():
		var params := {"requestId": request_id, "ok": true, "data": data}
		if not binary.is_empty():
			params.binary = binary
		var timeout_ms := 5000 if deadline_unix_ms <= 0 else clampi(deadline_unix_ms - int(Time.get_unix_time_from_system() * 1000.0), 1, 5000)
		_send_signed("command.result", params, timeout_ms)

func send_command_chunk(request_id: String, index: int, total: int, sha256: String, data: String) -> void:
	if is_attached():
		_send_signed("command.chunk", {"requestId": request_id, "index": index, "total": total, "sha256": sha256, "data": data}, 5000)

func send_command_chunk_flow_controlled(request_id: String, index: int, total: int, sha256: String, data: String, deadline_unix_ms: int) -> bool:
	while is_attached() and _socket.get_current_outbound_buffered_amount() > OUTBOUND_DRAIN_TARGET_BYTES:
		if int(Time.get_unix_time_from_system() * 1000.0) >= deadline_unix_ms:
			return false
		_socket.poll()
		await get_tree().process_frame
	var remaining_ms := deadline_unix_ms - int(Time.get_unix_time_from_system() * 1000.0)
	if not is_attached() or remaining_ms <= 0:
		return false
	return _send_signed("command.chunk", {"requestId": request_id, "index": index, "total": total, "sha256": sha256, "data": data}, mini(remaining_ms, 5000)) == OK

func send_command_error(request_id: String, code: String, message: String, retryable: bool = false) -> void:
	if is_attached():
		_send_signed("command.result", {"requestId": request_id, "ok": false, "error": {"code": code, "message": message.left(4096), "retryable": retryable}}, 5000)

func close(reason: String = "closed") -> void:
	if _closed:
		return
	_closed = true
	set_process(false)
	if _socket != null:
		_socket.close(1000, reason)
		_socket = null
	_token_bytes.fill(0)
	_token_bytes = PackedByteArray()
	_session_key.fill(0)
	_session_key = PackedByteArray()
	if _paired:
		_paired = false
		disconnected.emit(reason)
