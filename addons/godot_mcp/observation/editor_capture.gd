@tool
class_name GodotMcpEditorCapture
extends RefCounted

const MAX_BYTES := 8 * 1024 * 1024
const MAX_CHUNK_BYTES := 512 * 1024

var _editor: EditorInterface

func _init(editor: EditorInterface) -> void:
	_editor = editor

static func chunk_bytes(bytes: PackedByteArray, chunk_size: int = MAX_CHUNK_BYTES) -> Array[PackedByteArray]:
	var chunks: Array[PackedByteArray] = []
	var offset := 0
	while offset < bytes.size():
		chunks.append(bytes.slice(offset, mini(offset + chunk_size, bytes.size())))
		offset += chunk_size
	return chunks

func execute(arguments: Dictionary) -> Dictionary:
	var viewport_name := String(arguments.get("viewport", ""))
	var viewport: SubViewport
	var viewport_index := int(arguments.get("viewportIndex", 0))
	if viewport_name == "2d":
		viewport = _editor.get_editor_viewport_2d()
	elif viewport_name == "3d" and viewport_index >= 0 and viewport_index <= 3:
		viewport = _editor.get_editor_viewport_3d(viewport_index)
	else:
		return _error("INVALID_REQUEST", "Viewport selection is invalid")
	if viewport == null:
		return _error("TARGET_NOT_FOUND", "Editor viewport is unavailable")
	await RenderingServer.frame_post_draw
	var image := viewport.get_texture().get_image()
	if image == null or image.is_empty():
		return _error("TARGET_NOT_FOUND", "Editor viewport returned no image")
	var max_width := clampi(int(arguments.get("maxWidth", 1280)), 1, 2048)
	var max_height := clampi(int(arguments.get("maxHeight", 720)), 1, 2048)
	if image.get_width() > max_width or image.get_height() > max_height:
		var scale := minf(float(max_width) / image.get_width(), float(max_height) / image.get_height())
		image.resize(maxi(1, int(floor(image.get_width() * scale))), maxi(1, int(floor(image.get_height() * scale))), Image.INTERPOLATE_LANCZOS)
	var png := image.save_png_to_buffer()
	if png.is_empty() or png.size() > MAX_BYTES:
		return _error("PAYLOAD_TOO_LARGE", "Editor viewport PNG exceeds 8 MiB")
	var hashing := HashingContext.new()
	hashing.start(HashingContext.HASH_SHA256)
	hashing.update(png)
	var sha256 := hashing.finish().hex_encode()
	var byte_chunks := chunk_bytes(png)
	var chunks: Array[String] = []
	for chunk in byte_chunks:
		chunks.append(Marshalls.raw_to_base64(chunk))
	var metadata := {
		"mimeType": "image/png", "viewport": viewport_name, "viewportIndex": viewport_index if viewport_name == "3d" else null,
		"width": image.get_width(), "height": image.get_height(), "byteLength": png.size(), "sha256": sha256,
	}
	return {"ok": true, "data": metadata, "chunks": chunks, "binary": {"size": png.size(), "sha256": sha256, "chunks": chunks.size()}}

func _error(code: String, message: String) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": false}
