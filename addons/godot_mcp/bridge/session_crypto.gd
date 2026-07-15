@tool
class_name GodotMcpSessionCrypto
extends RefCounted

const CanonicalJson = preload("res://addons/godot_mcp/bridge/canonical_json.gd")

static func base64url_decode(value: String) -> PackedByteArray:
	var normalized := value.replace("-", "+").replace("_", "/")
	while normalized.length() % 4 != 0:
		normalized += "="
	return Marshalls.base64_to_raw(normalized)

static func hmac_sha256(key: PackedByteArray, message: String) -> PackedByteArray:
	var context := HMACContext.new()
	var error := context.start(HashingContext.HASH_SHA256, key)
	assert(error == OK)
	error = context.update(message.to_utf8_buffer())
	assert(error == OK)
	return context.finish()

static func derive_key(token: String, session_nonce: String, server_nonce: String) -> PackedByteArray:
	var token_bytes := base64url_decode(token)
	assert(token_bytes.size() == 32)
	return hmac_sha256(token_bytes, "godot-mcp:v1\n%s\n%s" % [session_nonce, server_nonce])

static func signing_text(envelope: Dictionary) -> String:
	return "%s\n%s\n%s\n%s\n%s" % [
		envelope.sessionId,
		str(envelope.sequence),
		str(envelope.deadlineUnixMs),
		envelope.method,
		CanonicalJson.encode(envelope.params),
	]

static func sign(envelope: Dictionary, key: PackedByteArray) -> String:
	return _sign_message(envelope, key)

static func _sign_message(envelope: Dictionary, key: PackedByteArray) -> String:
	return hmac_sha256(key, signing_text(envelope)).hex_encode()

static func sign_envelope(envelope: Dictionary, key: PackedByteArray) -> Dictionary:
	var signed := envelope.duplicate(true)
	signed.mac = _sign_message(envelope, key)
	return signed

static func constant_time_equal(left: String, right: String) -> bool:
	var left_bytes := left.to_utf8_buffer()
	var right_bytes := right.to_utf8_buffer()
	if left_bytes.size() != right_bytes.size():
		return false
	var difference := 0
	for index in left_bytes.size():
		difference |= left_bytes[index] ^ right_bytes[index]
	return difference == 0

static func verify_envelope(
	envelope: Dictionary,
	key: PackedByteArray,
	last_sequence: int,
	expected_session_id: String
) -> bool:
	for field in ["sessionId", "sequence", "deadlineUnixMs", "method", "params", "mac"]:
		if not envelope.has(field):
			return false
	if envelope.sessionId != expected_session_id:
		return false
	if int(envelope.sequence) <= last_sequence:
		return false
	var now_ms := int(Time.get_unix_time_from_system() * 1000.0)
	var deadline_ms := int(envelope.deadlineUnixMs)
	if deadline_ms < now_ms or deadline_ms - now_ms > 60000:
		return false
	return constant_time_equal(String(envelope.mac), _sign_message(envelope, key))

static func server_proof(token: String, session_id: String, server_nonce: String) -> String:
	return hmac_sha256(
		base64url_decode(token),
		"godot-mcp:server-proof:v1\n%s\n%s" % [session_id, server_nonce]
	).hex_encode()
