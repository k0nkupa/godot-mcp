class_name GodotMcpRuntimeFrameClock
extends RefCounted

const RuntimeDeadline = preload("res://addons/godot_mcp/runtime/runtime_deadline.gd")

var _root: Node

func _init(root: Node) -> void:
	_root = root

func advance_paused(frames: int, deadline_unix_ms: int) -> Dictionary:
	if frames < 0 or frames > 1800:
		return _error("INVALID_REQUEST", "Runtime frame count is invalid")
	if not is_instance_valid(_root) or _root.get_tree() == null:
		return _error("TARGET_NOT_FOUND", "Runtime scene changed")
	var tree := _root.get_tree()
	if not tree.paused:
		return _error("PRECONDITION_FAILED", "Runtime must be paused before frame stepping")
	for _frame in frames:
		if _now_ms() >= deadline_unix_ms:
			return _error("TIMEOUT", "Runtime step deadline expired", true)
		var post_draw := RuntimeDeadline.post_draw_latch(tree, deadline_unix_ms)
		tree.paused = false
		await tree.process_frame
		if not is_instance_valid(_root):
			tree.paused = true
			post_draw.release()
			return _error("TARGET_NOT_FOUND", "Runtime scene changed", true)
		if not post_draw.finished:
			await post_draw.completed
		tree.paused = true
		post_draw.release()
		if not is_instance_valid(_root):
			return _error("TARGET_NOT_FOUND", "Runtime scene changed", true)
		if not post_draw.drew_frame or _now_ms() >= deadline_unix_ms:
			return _error("TIMEOUT", "Runtime step deadline expired", true)
	return {"ok": true, "data": frame_state()}

func frame_state() -> Dictionary:
	if not is_instance_valid(_root): return {}
	return {
		"paused": _root.get_tree().paused,
		"processFrames": Engine.get_process_frames(),
		"physicsFrames": Engine.get_physics_frames(),
	}

static func _now_ms() -> int:
	return int(Time.get_unix_time_from_system() * 1000.0)

static func _error(code: String, message: String, retryable := false) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": retryable}
