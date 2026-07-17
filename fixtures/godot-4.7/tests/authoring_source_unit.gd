extends SceneTree

const SourceAuthoring = preload("res://addons/godot_mcp/authoring/source_authoring.gd")
const ProjectFileTransaction = preload("res://addons/godot_mcp/mutation/project_file_transaction.gd")

func _init() -> void:
	var create_path := "res://mutation/generated_phase6.gd"
	DirAccess.remove_absolute(ProjectSettings.globalize_path(create_path))
	var script_ok := SourceAuthoring.prepare({
		"operation": "create_script",
		"sourcePath": create_path,
		"content": "extends Node\r\nvar value := 1\r\n",
	})
	assert(script_ok.ok and script_ok.normalizedContent == "extends Node\nvar value := 1\n")
	assert(script_ok.parseStatus == "valid")

	var script_bad := SourceAuthoring.prepare({
		"operation": "create_script",
		"sourcePath": "res://mutation/bad.gd",
		"content": "extends Node\nfunc broken(\n",
	})
	assert(not script_bad.ok and script_bad.code == "GODOT_PARSE_ERROR")
	assert(not JSON.stringify(script_bad).contains("func broken"))

	var shader_ok := SourceAuthoring.prepare({
		"operation": "create_shader",
		"sourcePath": "res://mutation/generated_phase6.gdshader",
		"content": "shader_type canvas_item;\nvoid fragment() { COLOR = vec4(1.0); }\n",
	})
	assert(shader_ok.ok and shader_ok.parseStatus == "valid")
	var shader_bad := SourceAuthoring.prepare({
		"operation": "create_shader",
		"sourcePath": "res://mutation/bad.gdshader",
		"content": "shader_type canvas_item; void fragment( {",
	})
	assert(not shader_bad.ok and shader_bad.code == "GODOT_PARSE_ERROR")

	assert(SourceAuthoring.prepare({"operation": "create_script", "sourcePath": "res://addons/escape.gd", "content": "extends Node\n"}).code == "PATH_DENIED")
	assert(SourceAuthoring.prepare({"operation": "create_script", "sourcePath": "res://mutation/nul.gd", "content": "extends Node" + String.chr(0xfffd)}).code == "INVALID_REQUEST")

	var transaction := ProjectFileTransaction.new(ProjectSettings.globalize_path("res://"), null, "phase6-source-unit")
	assert(transaction.prepare_external(script_ok.prepared).ok)
	transaction.apply_all(true)
	assert(transaction.failure.is_empty())
	assert(FileAccess.get_file_as_string(create_path) == script_ok.normalizedContent)
	transaction.apply_all(false)
	assert(transaction.failure.is_empty() and not FileAccess.file_exists(create_path))

	var replace_path := "res://mutation/replace_phase6.gd"
	_write(replace_path, "extends Node\nvar value := 1\n")
	var expected_hash := _sha256(FileAccess.get_file_as_bytes(replace_path))
	assert(SourceAuthoring.prepare({
		"operation": "replace_script", "sourcePath": replace_path,
		"expectedSha256": "0".repeat(64), "content": "extends Node\nvar value := 2\n",
	}).code == "PRECONDITION_FAILED")
	var replace := SourceAuthoring.prepare({
		"operation": "replace_script", "sourcePath": replace_path,
		"expectedSha256": expected_hash, "content": "extends Node\nvar value := 2\n",
	})
	assert(replace.ok)
	DirAccess.remove_absolute(ProjectSettings.globalize_path(replace_path))
	print("PHASE6_SOURCE_UNIT_OK")
	quit(0)

func _write(path: String, content: String) -> void:
	var file := FileAccess.open(path, FileAccess.WRITE)
	assert(file != null)
	file.store_string(content)
	file.close()

func _sha256(bytes: PackedByteArray) -> String:
	var context := HashingContext.new()
	context.start(HashingContext.HASH_SHA256)
	context.update(bytes)
	return context.finish().hex_encode()
