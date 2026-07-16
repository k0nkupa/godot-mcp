class_name GodotMcpRuntimeCapture
extends RefCounted

const EditorCapture = preload("res://addons/godot_mcp/observation/editor_capture.gd")
const RuntimeDeadline = preload("res://addons/godot_mcp/runtime/runtime_deadline.gd")
const MAX_BYTES := 8 * 1024 * 1024
const MAX_SOURCE_DIMENSION := 4096
const MAX_SOURCE_PIXELS := 4096 * 4096

var _root: Node
var _control: RefCounted

func _init(root: Node, control: RefCounted) -> void:
	_root = root
	_control = control

func execute(arguments: Dictionary, deadline_unix_ms: int) -> Dictionary:
	if not is_instance_valid(_root):
		return _error("TARGET_NOT_FOUND", "Runtime scene changed")
	var tree := _root.get_tree()
	var wait_frames := clampi(int(arguments.get("waitFrames", 0)), 0, 120)
	if wait_frames > 0:
		if tree.paused:
			if bool(arguments.get("advancePaused", false)):
				var stepped: Dictionary = await _control.execute("step", {"frames": wait_frames}, deadline_unix_ms)
				if not bool(stepped.get("ok", false)):
					return stepped
		else:
			for _frame in wait_frames:
				if _deadline_expired(deadline_unix_ms):
					return _error("TIMEOUT", "Runtime capture deadline expired", true)
				await tree.process_frame
				if _deadline_expired(deadline_unix_ms):
					return _error("TIMEOUT", "Runtime capture deadline expired", true)
	if _deadline_expired(deadline_unix_ms):
		return _error("TIMEOUT", "Runtime capture deadline expired", true)
	var post_draw := RuntimeDeadline.post_draw_latch(tree, deadline_unix_ms)
	if not post_draw.finished:
		await post_draw.completed
	post_draw.release()
	if not post_draw.drew_frame:
		return _error("TIMEOUT", "Runtime capture deadline expired", true)
	if not is_instance_valid(_root):
		return _error("TARGET_NOT_FOUND", "Runtime scene changed")
	var texture := _root.get_viewport().get_texture()
	if texture == null or not source_dimensions_allowed(texture.get_width(), texture.get_height()):
		return _error("PAYLOAD_TOO_LARGE", "Runtime source viewport exceeds the safe readback bound")
	var image := texture.get_image()
	if image == null or image.is_empty():
		return _error("TARGET_NOT_FOUND", "Runtime viewport returned no image")
	var max_width := clampi(int(arguments.get("maxWidth", 1280)), 1, 2048)
	var max_height := clampi(int(arguments.get("maxHeight", 720)), 1, 2048)
	if image.get_width() > max_width or image.get_height() > max_height:
		var scale := minf(float(max_width) / image.get_width(), float(max_height) / image.get_height())
		image.resize(maxi(1, int(floor(image.get_width() * scale))), maxi(1, int(floor(image.get_height() * scale))), Image.INTERPOLATE_LANCZOS)
	var png := image.save_png_to_buffer()
	if png.is_empty() or png.size() > MAX_BYTES:
		return _error("PAYLOAD_TOO_LARGE", "Runtime viewport PNG exceeds 8 MiB")
	var hashing := HashingContext.new()
	hashing.start(HashingContext.HASH_SHA256)
	hashing.update(png)
	var sha256 := hashing.finish().hex_encode()
	var chunks: Array[String] = []
	for chunk in EditorCapture.chunk_bytes(png):
		chunks.append(Marshalls.raw_to_base64(chunk))
	var metadata := {
		"mimeType": "image/png",
		"width": image.get_width(),
		"height": image.get_height(),
		"byteLength": png.size(),
		"sha256": sha256,
		"frameIndex": clampi(int(arguments.get("frameIndex", 0)), 0, 7),
	}
	return {"ok": true, "data": metadata, "chunks": chunks, "binary": {"size": png.size(), "sha256": sha256, "chunks": chunks.size()}}

static func _error(code: String, message: String, retryable := false) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": retryable}

static func _deadline_expired(deadline_unix_ms: int) -> bool:
	return int(Time.get_unix_time_from_system() * 1000.0) >= deadline_unix_ms

static func source_dimensions_allowed(width: int, height: int) -> bool:
	return width > 0 and height > 0 and width <= MAX_SOURCE_DIMENSION and height <= MAX_SOURCE_DIMENSION and width * height <= MAX_SOURCE_PIXELS
