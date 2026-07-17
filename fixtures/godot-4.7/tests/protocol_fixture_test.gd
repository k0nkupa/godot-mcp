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
	var float_value := 0.000493333333333333
	assert(SessionCrypto._canonical_signing_params(float_value) == {
		"type": "FloatJson", "value": JSON.stringify(float_value),
	})
	var fixture: Dictionary = JSON.parse_string(FileAccess.get_file_as_string("res://protocol-fixtures/session-crypto-v1.json"))
	fixture.envelope = _restore_safe_json_integers(fixture.envelope)
	var key: PackedByteArray = SessionCrypto.derive_key(fixture.token, fixture.sessionNonce, fixture.serverNonce)
	assert(key.hex_encode() == fixture.derivedKeyHex)
	assert(CanonicalJson.encode(fixture.envelope.params) == fixture.canonicalPayloadText)
	assert(SessionCrypto.sign(fixture.envelope, key) == fixture.macHex)
	print("GODOT_MCP_PROTOCOL_FIXTURE_OK")
	quit(0)
