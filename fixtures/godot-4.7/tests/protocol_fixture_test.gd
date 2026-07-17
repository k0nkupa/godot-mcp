extends SceneTree

const CanonicalJson = preload("res://addons/godot_mcp/bridge/canonical_json.gd")
const SessionCrypto = preload("res://addons/godot_mcp/bridge/session_crypto.gd")

func _restore_safe_json_integers(value: Variant) -> Variant:
	if typeof(value) == TYPE_FLOAT:
		assert(is_finite(value) and floor(value) == value)
		assert(abs(value) <= CanonicalJson.MAX_SAFE_INTEGER)
		return int(value)
	if typeof(value) == TYPE_ARRAY:
		var restored: Array = []
		for item in value:
			restored.append(_restore_safe_json_integers(item))
		return restored
	if typeof(value) == TYPE_DICTIONARY:
		var restored: Dictionary = {}
		for key in value:
			restored[key] = _restore_safe_json_integers(value[key])
		return restored
	return value

func _init() -> void:
	var float_value: float = JSON.parse_string("0.000493333333333333")
	assert(SessionCrypto._canonical_signing_params(float_value) == {
		"$godotMcpFloat64Le": "704b2f44612a403f",
	}, JSON.stringify(SessionCrypto._canonical_signing_params(float_value)))
	var precise: float = JSON.parse_string("0.12345678901234567")
	var tiny: float = JSON.parse_string("1e-300")
	var huge: float = JSON.parse_string("1.2345678901234567e+100")
	var unsafe_integral_float: float = JSON.parse_string("9007199254740992.0")
	assert(SessionCrypto._canonical_signing_params(unsafe_integral_float) == {
		"$godotMcpFloat64Le": SessionCrypto.float64_le_hex(unsafe_integral_float),
	})
	assert(not SessionCrypto._valid_float_wire_params({"$godotMcpFloat64Le": "000000000000f07f"}))
	assert(not SessionCrypto._valid_float_wire_params({"$godotMcpFloat64Le": "000000000000f87f"}))
	assert(not SessionCrypto._valid_float_wire_params({"$godotMcpFloat64Le": "-000000000000000"}))
	assert(not SessionCrypto._valid_float_wire_params({"$godotMcpFloat64Le": "+000000000000000"}))
	assert(not SessionCrypto._valid_float_wire_params({"$godotMcpFloat64Le": "000000000000F03f"}))
	assert(SessionCrypto.float64_le_hex(precise) == "5ff64637dd9abf3f", SessionCrypto.float64_le_hex(precise))
	assert(SessionCrypto.float64_le_hex(tiny) == "59f3f8c21f6ea501", SessionCrypto.float64_le_hex(tiny))
	assert(SessionCrypto.float64_le_hex(huge) == "84f19de8d893b654", SessionCrypto.float64_le_hex(huge))
	for encoded in ["8c4b2f44612a403f", "5ef64637dd9abf3f", "59f3f8c21f6ea501", "83f19de8d893b654"]:
		var decoded: float = SessionCrypto._decode_float_params({"$godotMcpFloat64Le": encoded})
		assert(SessionCrypto.float64_le_hex(decoded) == encoded)
	assert(SessionCrypto.sign_envelope({"sessionId": "s", "sequence": 1, "deadlineUnixMs": 2, "method": "m", "params": {"$godotMcpFloat64Le": "000000000000d03f"}}, PackedByteArray([1])).is_empty())
	var fixture: Dictionary = JSON.parse_string(FileAccess.get_file_as_string("res://protocol-fixtures/session-crypto-v1.json"))
	fixture.envelope = _restore_safe_json_integers(fixture.envelope)
	var key: PackedByteArray = SessionCrypto.derive_key(fixture.token, fixture.sessionNonce, fixture.serverNonce)
	assert(key.hex_encode() == fixture.derivedKeyHex)
	assert(CanonicalJson.encode(fixture.envelope.params) == fixture.canonicalPayloadText)
	assert(SessionCrypto.sign(fixture.envelope, key) == fixture.macHex)
	print("GODOT_MCP_PROTOCOL_FIXTURE_OK")
	quit(0)
