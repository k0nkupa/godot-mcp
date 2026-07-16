class_name GodotMcpRuntimeDeadline
extends RefCounted

class PostDrawLatch:
	extends RefCounted
	signal completed
	var finished := false
	var drew_frame := false
	var draw_callback: Callable
	var timer_callback: Callable
	var timer: SceneTreeTimer

	func resolve(did_draw: bool) -> void:
		if finished:
			return
		finished = true
		drew_frame = did_draw
		completed.emit()

	func release() -> void:
		if RenderingServer.frame_post_draw.is_connected(draw_callback):
			RenderingServer.frame_post_draw.disconnect(draw_callback)
		if timer != null and timer.timeout.is_connected(timer_callback):
			timer.timeout.disconnect(timer_callback)

static func post_draw_latch(tree: SceneTree, deadline_unix_ms: int) -> PostDrawLatch:
	var latch := PostDrawLatch.new()
	latch.draw_callback = latch.resolve.bind(true)
	RenderingServer.frame_post_draw.connect(latch.draw_callback, CONNECT_ONE_SHOT)
	var remaining_seconds := maxf(0.001, float(deadline_unix_ms - _now_ms()) / 1000.0)
	latch.timer = tree.create_timer(remaining_seconds, true, false, true)
	latch.timer_callback = latch.resolve.bind(false)
	latch.timer.timeout.connect(latch.timer_callback, CONNECT_ONE_SHOT)
	return latch

static func _now_ms() -> int:
	return int(Time.get_unix_time_from_system() * 1000.0)
