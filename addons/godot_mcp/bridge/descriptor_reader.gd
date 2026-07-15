@tool
class_name GodotMcpDescriptorReader
extends RefCounted

const ProtocolConstants = preload("res://addons/godot_mcp/generated/protocol_constants.gd")

static func _sha256_hex(value: PackedByteArray) -> String:
	var context := HashingContext.new()
	if context.start(HashingContext.HASH_SHA256) != OK:
		return ""
	if context.update(value) != OK:
		return ""
	return context.finish().hex_encode()

static func read_project_identity() -> Dictionary:
	var config_path := ProjectSettings.globalize_path("res://.godot-mcp.json")
	if not FileAccess.file_exists(config_path):
		return {}
	var config := JSON.parse_string(FileAccess.get_file_as_string(config_path))
	if typeof(config) != TYPE_DICTIONARY or not config.has("projectId"):
		return {}
	var project_path := ProjectSettings.globalize_path("res://project.godot")
	var project_bytes := FileAccess.get_file_as_bytes(project_path)
	if project_bytes.is_empty():
		return {}
	var root_path := ProjectSettings.globalize_path("res://").trim_suffix("/")
	return {
		"projectId": config.projectId,
		"rootRealPath": root_path,
		"projectConfigSha256": _sha256_hex(project_bytes),
	}

static func runtime_directory() -> String:
	var base := OS.get_environment("XDG_RUNTIME_DIR")
	if base.is_empty():
		base = OS.get_environment("TMPDIR")
	if base.is_empty():
		return ""
	return base.path_join("godot-mcp")

static func descriptor_path(project_id: String) -> String:
	var runtime := runtime_directory()
	if runtime.is_empty():
		return ""
	return runtime.path_join("pair-%s.json" % project_id)

static func read_for_project(identity: Dictionary) -> Dictionary:
	if not identity.has("projectId") or not identity.has("projectConfigSha256"):
		return {}
	var path := descriptor_path(identity.projectId)
	if path.is_empty() or not FileAccess.file_exists(path):
		return {}
	var descriptor := JSON.parse_string(FileAccess.get_file_as_string(path))
	if typeof(descriptor) != TYPE_DICTIONARY:
		return {}
	for field in [
		"protocolVersion", "productVersion", "project", "port", "sessionNonce",
		"token", "grants", "createdAtUnixMs", "expiresAtUnixMs"
	]:
		if not descriptor.has(field):
			return {}
	if descriptor.protocolVersion != ProtocolConstants.BRIDGE_PROTOCOL_VERSION:
		return {}
	if descriptor.productVersion != ProtocolConstants.PRODUCT_VERSION:
		return {}
	if int(descriptor.expiresAtUnixMs) < int(Time.get_unix_time_from_system() * 1000.0):
		return {}
	if descriptor.project.projectId != identity.projectId:
		return {}
	if descriptor.project.projectConfigSha256 != identity.projectConfigSha256:
		return {}
	descriptor["descriptorPath"] = path
	return descriptor

static func delete_descriptor(path: String) -> void:
	if not path.is_empty() and FileAccess.file_exists(path):
		DirAccess.remove_absolute(path)
