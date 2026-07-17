@tool
class_name GodotMcpSessionCrypto
extends RefCounted

const CanonicalJson = preload("res://addons/godot_mcp/bridge/canonical_json.gd")
const MAX_SAFE_INTEGER := 9007199254740991
const FLOAT_WIRE_KEY := "$godotMcpFloat64Le"

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
		str(int(envelope.sequence)),
		str(int(envelope.deadlineUnixMs)),
		envelope.method,
		CanonicalJson.encode(_canonical_signing_params(envelope.params)),
	]

static func _canonical_signing_params(value: Variant) -> Variant:
	if (
		typeof(value) == TYPE_FLOAT
		and is_finite(value)
		and (floor(value) != value or absf(value) > float(MAX_SAFE_INTEGER))
	):
		return {"$godotMcpFloat64Le": float64_le_hex(value)}
	if typeof(value) == TYPE_ARRAY:
		var result: Array = []
		for entry in value:
			result.append(_canonical_signing_params(entry))
		return result
	if typeof(value) == TYPE_DICTIONARY:
		var result: Dictionary = {}
		for key in value:
			result[key] = _canonical_signing_params(value[key])
		return result
	return value

static func float64_le_hex(value: float) -> String:
	assert(is_finite(value))
	var bytes := PackedByteArray()
	bytes.resize(8)
	bytes.encode_double(0, value)
	return bytes.hex_encode()

static func sign(envelope: Dictionary, key: PackedByteArray) -> String:
	return _sign_message(envelope, key)

static func _sign_message(envelope: Dictionary, key: PackedByteArray) -> String:
	return hmac_sha256(key, signing_text(envelope)).hex_encode()

static func sign_envelope(envelope: Dictionary, key: PackedByteArray) -> Dictionary:
	if _contains_reserved_float_wire(envelope.get("params")):
		return {}
	var signed := envelope.duplicate(true)
	signed.params = _canonical_signing_params(envelope.params)
	signed.mac = _sign_message(signed, key)
	return signed

static func _contains_reserved_float_wire(value: Variant) -> bool:
	if typeof(value) == TYPE_ARRAY:
		for entry in value:
			if _contains_reserved_float_wire(entry): return true
		return false
	if typeof(value) != TYPE_DICTIONARY:
		return false
	if value.size() == 1 and value.has(FLOAT_WIRE_KEY):
		return true
	for entry in value.values():
		if _contains_reserved_float_wire(entry): return true
	return false

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
	if not _is_safe_protocol_integer(envelope.sequence):
		return false
	if not _is_safe_protocol_integer(envelope.deadlineUnixMs):
		return false
	if int(envelope.sequence) <= last_sequence:
		return false
	if not _valid_float_wire_params(envelope.params):
		return false
	var now_ms := int(Time.get_unix_time_from_system() * 1000.0)
	var deadline_ms := int(envelope.deadlineUnixMs)
	if deadline_ms < now_ms or deadline_ms - now_ms > 60000:
		return false
	if not constant_time_equal(String(envelope.mac), _sign_message(envelope, key)):
		return false
	envelope.params = _decode_float_params(envelope.params)
	return true

static func _valid_float_wire_params(value: Variant) -> bool:
	if typeof(value) == TYPE_ARRAY:
		for entry in value:
			if not _valid_float_wire_params(entry): return false
		return true
	if typeof(value) != TYPE_DICTIONARY:
		return true
	if value.size() == 1 and value.has(FLOAT_WIRE_KEY):
		var encoded: Variant = value[FLOAT_WIRE_KEY]
		return typeof(encoded) == TYPE_STRING and encoded.length() == 16 and String(encoded) == String(encoded).to_lower() and String(encoded).is_valid_hex_number(false)
	for entry in value.values():
		if not _valid_float_wire_params(entry): return false
	return true

static func _decode_float_params(value: Variant) -> Variant:
	if typeof(value) == TYPE_ARRAY:
		return value.map(func(entry: Variant) -> Variant: return _decode_float_params(entry))
	if typeof(value) != TYPE_DICTIONARY:
		return value
	if value.size() == 1 and value.has(FLOAT_WIRE_KEY):
		return String(value[FLOAT_WIRE_KEY]).hex_decode().decode_double(0)
	var decoded := {}
	for key in value:
		decoded[key] = _decode_float_params(value[key])
	return decoded

static func _is_safe_protocol_integer(value: Variant) -> bool:
	if typeof(value) == TYPE_INT:
		return abs(value) <= MAX_SAFE_INTEGER
	if typeof(value) != TYPE_FLOAT or is_nan(value) or is_inf(value):
		return false
	return floor(value) == value and abs(value) <= MAX_SAFE_INTEGER

static func server_proof(token: String, session_id: String, server_nonce: String) -> String:
	return hmac_sha256(
		base64url_decode(token),
		"godot-mcp:server-proof:v1\n%s\n%s" % [session_id, server_nonce]
	).hex_encode()
