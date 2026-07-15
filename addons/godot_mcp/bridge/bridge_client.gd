@tool
class_name GodotMcpBridgeClient
extends Node

const DescriptorReader = preload("res://addons/godot_mcp/bridge/descriptor_reader.gd")
const ProtocolConstants = preload("res://addons/godot_mcp/generated/protocol_constants.gd")
const SessionCrypto = preload("res://addons/godot_mcp/bridge/session_crypto.gd")

signal attached(session_info: Dictionary)
signal rejected(code: String, message: String)
signal disconnected(reason: String)

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
	# Phase 1 deliberately refuses all post-pair commands.
	rejected.emit("INVALID_REQUEST", "Phase 1 accepts no bridge commands")

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
	_send_signed("addon.ready", {
		"project": _identity,
		"godotVersion": _godot_version(),
		"featureTags": ProjectSettings.get_setting("application/config/features", PackedStringArray()),
		"addonManifestSha256": _addon_manifest_hash(),
		"pluginEnabled": true,
	}, 30000)

func _send_signed(method: String, params: Variant, timeout_ms: int) -> void:
	_send_sequence += 1
	var envelope := {
		"sessionId": _session_id,
		"sequence": _send_sequence,
		"deadlineUnixMs": int(Time.get_unix_time_from_system() * 1000.0) + timeout_ms,
		"method": method,
		"params": params,
	}
	_socket.send_text(JSON.stringify(SessionCrypto.sign_envelope(envelope, _session_key)))

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
