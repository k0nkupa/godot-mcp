extends SceneTree

const EventFactory = preload("res://addons/godot_mcp/runtime/runtime_input_event_factory.gd")
const InputCoordinates = preload("res://addons/godot_mcp/runtime/runtime_input_coordinates.gd")
const InputState = preload("res://addons/godot_mcp/runtime/runtime_input_state.gd")
const RuntimeInput = preload("res://addons/godot_mcp/runtime/runtime_input.gd")
const RuntimeInputTrace = preload("res://addons/godot_mcp/runtime/runtime_input_trace.gd")

class UnitFrameClock:
	extends RefCounted
	var tree: SceneTree

	func _init(root_node: Node) -> void:
		tree = root_node.get_tree()

	func advance_paused(frames: int, deadline_unix_ms: int) -> Dictionary:
		for _frame in frames:
			if Time.get_unix_time_from_system() * 1000.0 >= deadline_unix_ms:
				return {"ok": false, "code": "TIMEOUT", "message": "Unit deadline expired", "retryable": true}
			tree.paused = false
			await tree.process_frame
			tree.paused = true
		return {"ok": true}

func _init() -> void:
	if not InputMap.has_action("phase_4_accept"):
		InputMap.add_action("phase_4_accept")
	var action: Dictionary = EventFactory.build({
		"type": "action", "action": "phase_4_accept", "pressed": true, "strengthMillionths": 500000,
	})
	assert(action.ok and action.route == "global" and action.events.size() == 1)
	assert(action.events[0] is InputEventAction and action.events[0].pressed and is_equal_approx(action.events[0].strength, 0.5))
	assert(EventFactory.build({"type": "action", "action": "missing", "pressed": true, "strengthMillionths": 1000000}).code == "TARGET_NOT_FOUND")
	assert(EventFactory.build({"type": "key", "keycode": 65, "pressed": true, "text": "denied"}).code == "INVALID_REQUEST")

	var key: Dictionary = EventFactory.build({
		"type": "key", "keycode": 65, "physicalKeycode": 0, "unicode": 0, "pressed": true, "echo": false,
		"modifiers": {"alt": false, "ctrl": true, "meta": false, "shift": true},
	})
	assert(key.ok and key.events[0] is InputEventKey and key.events[0].ctrl_pressed and key.events[0].shift_pressed)
	var mouse: Dictionary = EventFactory.build({
		"type": "mouse_motion", "position": {"x": 10, "y": 20}, "viewportPath": ".", "coordinateSpace": "viewport",
		"relative": {"x": 2, "y": -1}, "velocity": {"x": 120, "y": 0}, "pressureMillionths": 250000,
		"tiltMillionths": {"x": -500000, "y": 500000}, "modifiers": {"alt": false, "ctrl": false, "meta": false, "shift": false},
	})
	assert(mouse.ok and mouse.route == "viewport" and mouse.events[0] is InputEventMouseMotion)
	assert(mouse.events[0].relative == Vector2(2, -1) and is_equal_approx(mouse.events[0].pressure, 0.25))
	var scroll: Dictionary = EventFactory.build({
		"type": "scroll", "position": {"x": 10, "y": 20}, "viewportPath": ".", "coordinateSpace": "viewport",
		"delta": {"x": 2, "y": -3}, "modifiers": {"alt": false, "ctrl": false, "meta": false, "shift": false},
	})
	assert(scroll.ok and scroll.events.size() == 4)
	assert(scroll.events[0].button_index == MOUSE_BUTTON_WHEEL_RIGHT and scroll.events[0].pressed)
	assert(scroll.events[1].button_index == MOUSE_BUTTON_WHEEL_RIGHT and not scroll.events[1].pressed)
	assert(scroll.events[2].button_index == MOUSE_BUTTON_WHEEL_UP and is_equal_approx(scroll.events[2].factor, 3.0))

	var touch: Dictionary = EventFactory.build({
		"type": "touch", "position": {"x": 250000, "y": 750000}, "viewportPath": "Embedded",
		"coordinateSpace": "normalized", "index": 3, "pressed": true, "canceled": false, "doubleTap": false,
	})
	assert(touch.ok and touch.events[0] is InputEventScreenTouch and touch.events[0].index == 3)
	var drag: Dictionary = EventFactory.build({
		"type": "touch_drag", "position": {"x": 10, "y": 20}, "viewportPath": ".", "coordinateSpace": "viewport",
		"index": 3, "relative": {"x": 1, "y": 2}, "velocity": {"x": 3, "y": 4}, "pressureMillionths": 500000,
		"tiltMillionths": {"x": 0, "y": 0},
	})
	assert(drag.ok and drag.events[0] is InputEventScreenDrag and drag.events[0].relative == Vector2(1, 2))
	assert(EventFactory.build({"type": "joypad_motion", "device": 0, "axis": 1, "axisValueMillionths": -500000}).events[0] is InputEventJoypadMotion)
	assert(EventFactory.build({"type": "magnify_gesture", "position": {"x": 1, "y": 2}, "viewportPath": ".", "coordinateSpace": "viewport", "factorMillionths": 1250000}).events[0] is InputEventMagnifyGesture)

	await process_frame
	var fixture_scene := load("res://input/input_fixture.tscn") as PackedScene
	var fixture := fixture_scene.instantiate()
	root.add_child(fixture)
	await process_frame
	fixture._input(action.events[0])
	fixture._input(key.events[0])
	var action_release: Dictionary = EventFactory.build({
		"type": "action", "action": "phase_4_accept", "pressed": false,
		"strengthMillionths": 0,
	})
	fixture._input(action_release.events[0])
	assert(fixture.replay_delivery_order == "action,key,action")
	assert(fixture.replay_event_count == 3)
	assert(fixture.replay_last_kind == "action")
	assert(not fixture.replay_action_pressed and fixture.replay_keycode == 65)

	var replay_digest_before_noise: String = fixture.replay_digest
	var full_digest_before_noise: String = fixture.state_digest
	fixture._input(mouse.events[0])
	assert(fixture.state_digest != full_digest_before_noise)
	assert(fixture.replay_digest == replay_digest_before_noise)

	var reset_release := InputEventKey.new()
	reset_release.keycode = KEY_R
	reset_release.pressed = false
	fixture._input(reset_release)
	assert(fixture.replay_digest == replay_digest_before_noise)
	fixture.queue_free()
	await process_frame

	var game_root := Node.new()
	game_root.name = "Game"
	root.add_child(game_root)
	var embedded := SubViewport.new()
	embedded.name = "Embedded"
	embedded.size = Vector2i(320, 180)
	game_root.add_child(embedded)
	var normalized: Dictionary = InputCoordinates.resolve(game_root, touch.events[0], {
		"position": {"x": 250000, "y": 750000}, "viewportPath": "Embedded", "coordinateSpace": "normalized",
	})
	assert(normalized.ok and normalized.viewport == embedded and normalized.inLocalCoords)
	assert(normalized.events[0].position == Vector2(80, 135))
	assert(normalized.receipt == {"viewportPath": "Embedded", "coordinateSpace": "normalized", "visibleWidth": 320, "visibleHeight": 180})
	assert(InputCoordinates.resolve(game_root, touch.events[0], {
		"type": "touch", "position": {"x": 250000, "y": 750000}, "viewportPath": "Embedded",
		"coordinateSpace": "normalized", "index": 3, "pressed": true, "canceled": false, "doubleTap": false,
	}).ok)
	assert(InputCoordinates.resolve(game_root, touch.events[0], {"position": {"x": 0, "y": 0}, "viewportPath": "../Escape", "coordinateSpace": "viewport"}).code == "INVALID_REQUEST")
	var not_viewport := Node.new()
	not_viewport.name = "NotViewport"
	game_root.add_child(not_viewport)
	assert(InputCoordinates.resolve(game_root, touch.events[0], {"position": {"x": 0, "y": 0}, "viewportPath": "NotViewport", "coordinateSpace": "viewport"}).code == "TARGET_NOT_FOUND")

	var state := InputState.new()
	state.observe({"type": "action", "action": "phase_4_accept", "pressed": true, "strengthMillionths": 1000000})
	state.observe({"type": "key", "keycode": 65, "physicalKeycode": 0, "unicode": 0, "pressed": true, "echo": false, "modifiers": {"alt": false, "ctrl": false, "meta": false, "shift": false}})
	state.observe({"type": "touch", "position": {"x": 10, "y": 20}, "viewportPath": ".", "coordinateSpace": "viewport", "index": 2, "pressed": true, "canceled": false, "doubleTap": false})
	state.observe({"type": "touch_drag", "position": {"x": 30, "y": 40}, "viewportPath": ".", "coordinateSpace": "viewport", "index": 2, "relative": {"x": 20, "y": 20}, "velocity": {"x": 0, "y": 0}, "pressureMillionths": 0, "tiltMillionths": {"x": 0, "y": 0}})
	state.observe({"type": "mouse_button", "position": {"x": 10, "y": 20}, "viewportPath": ".", "coordinateSpace": "viewport", "buttonIndex": 1, "pressed": true, "doubleClick": false, "factorMillionths": 1000000, "modifiers": {"alt": false, "ctrl": false, "meta": false, "shift": false}})
	state.observe({"type": "mouse_motion", "position": {"x": 50, "y": 60}, "viewportPath": ".", "coordinateSpace": "viewport", "relative": {"x": 40, "y": 40}, "velocity": {"x": 0, "y": 0}, "pressureMillionths": 0, "tiltMillionths": {"x": 0, "y": 0}, "modifiers": {"alt": false, "ctrl": false, "meta": false, "shift": false}})
	state.observe({"type": "joypad_motion", "device": 0, "axis": 1, "axisValueMillionths": -500000})
	var releases: Array[Dictionary] = state.release_specs()
	assert(releases.size() == 5)
	assert(releases.any(func(spec: Dictionary) -> bool: return spec.type == "action" and not spec.pressed and spec.strengthMillionths == 0))
	assert(releases.any(func(spec: Dictionary) -> bool: return spec.type == "joypad_motion" and spec.axisValueMillionths == 0))
	assert(releases.any(func(spec: Dictionary) -> bool: return spec.type == "touch" and spec.position == {"x": 30, "y": 40}))
	assert(releases.any(func(spec: Dictionary) -> bool: return spec.type == "mouse_button" and spec.position == {"x": 50, "y": 60}))
	assert(state.release_specs().is_empty())

	var trace := RuntimeInputTrace.new()
	assert(trace.start(Engine.get_process_frames()).ok)
	assert(trace.start(Engine.get_process_frames()).code == "CONFLICT")
	for index in 256:
		assert(trace.append({"type": "action", "action": "phase_4_accept", "pressed": true, "strengthMillionths": 1000000}, 100 + index).ok)
	assert(trace.append({"type": "action", "action": "phase_4_accept", "pressed": false, "strengthMillionths": 0}, 256).code == "PAYLOAD_TOO_LARGE")
	var stopped_trace: Dictionary = trace.stop()
	assert(stopped_trace.ok and stopped_trace.trace.events.size() == 256 and not trace.is_active())
	assert(stopped_trace.trace.events[0].frameOffset == 0 and stopped_trace.trace.events[255].frameOffset == 255)
	assert(trace.start(0).ok)
	assert(trace.append({"type": "action", "action": "phase_4_accept", "pressed": true, "strengthMillionths": 1000000}, 100).ok)
	assert(trace.validate_append(1901).code == "PAYLOAD_TOO_LARGE")
	assert(trace.append({"type": "action", "action": "phase_4_accept", "pressed": false, "strengthMillionths": 0}, 1901).code == "PAYLOAD_TOO_LARGE")
	assert(trace.stop().trace.events.size() == 1)

	var runtime_input := RuntimeInput.new(game_root, UnitFrameClock.new(game_root))
	var handle := {"runId": "019f644c-1379-79c0-825e-66a4b7653bd1", "generation": 1}
	var recording_started: Dictionary = await runtime_input.execute({"operation": "record_start", "handle": handle}, _now_ms() + 5000)
	assert(recording_started.ok and recording_started.data.receipt.recording)
	var sent: Dictionary = await runtime_input.execute({
		"operation": "send", "handle": handle,
		"event": {"type": "action", "action": "phase_4_accept", "pressed": true, "strengthMillionths": 1000000},
	}, _now_ms() + 5000)
	assert(sent.ok and sent.data.receipt.eventCount == 1 and Input.is_action_pressed("phase_4_accept"))
	var rejected_while_recording: Dictionary = await runtime_input.execute({
		"operation": "send", "handle": handle,
		"event": {"type": "action", "action": "missing_action", "pressed": true, "strengthMillionths": 1000000},
	}, _now_ms() + 5000)
	assert(rejected_while_recording.code == "TARGET_NOT_FOUND")
	assert(not Input.is_action_pressed("phase_4_accept"))
	var recording_stopped: Dictionary = await runtime_input.execute({"operation": "record_stop", "handle": handle}, _now_ms() + 5000)
	assert(recording_stopped.ok and recording_stopped.data.trace.events.size() == 1)
	assert(recording_stopped.data.receipt.traceSha256 == RuntimeInput.trace_sha256(recording_stopped.data.trace))
	var released: Dictionary = runtime_input.release_all("unit")
	assert(released.ok and released.releases.is_empty())
	assert(runtime_input.release_all("again").releases.is_empty())
	var held_before_precondition: Dictionary = await runtime_input.execute({
		"operation": "send", "handle": handle,
		"event": {"type": "action", "action": "phase_4_accept", "pressed": true, "strengthMillionths": 1000000},
	}, _now_ms() + 5000)
	assert(held_before_precondition.ok and Input.is_action_pressed("phase_4_accept"))
	var rejected_mode: Dictionary = await runtime_input.execute({
		"operation": "replay", "handle": handle, "mode": "deterministic", "timeoutMs": 5000,
		"trace": {"schemaVersion": 1, "events": []},
	}, _now_ms() + 5000)
	assert(rejected_mode.code == "PRECONDITION_FAILED" and not Input.is_action_pressed("phase_4_accept"))

	paused = true
	var empty_replay: Dictionary = await runtime_input.execute({
		"operation": "replay", "handle": handle, "mode": "deterministic", "timeoutMs": 5000,
		"trace": {"schemaVersion": 1, "events": []},
	}, _now_ms() + 5000)
	assert(empty_replay.ok and empty_replay.data.receipt.eventCount == 0 and empty_replay.data.receipt.deterministic)
	var before_frames := Engine.get_process_frames()
	var deterministic: Dictionary = await runtime_input.execute({
		"operation": "sequence", "handle": handle, "mode": "deterministic", "timeoutMs": 5000,
		"events": [
			{"frameOffset": 0, "event": {"type": "action", "action": "phase_4_accept", "pressed": true, "strengthMillionths": 1000000}},
			{"frameOffset": 2, "event": {"type": "action", "action": "phase_4_accept", "pressed": false, "strengthMillionths": 0}},
		],
	}, _now_ms() + 5000)
	assert(deterministic.ok and deterministic.data.receipt.deterministic and deterministic.data.receipt.deliveredCount == 2)
	assert(Engine.get_process_frames() - before_frames == 3 and paused)
	assert(not Input.is_action_pressed("phase_4_accept"))
	var replayed: Dictionary = await runtime_input.execute({
		"operation": "replay", "handle": handle, "mode": "deterministic", "timeoutMs": 5000,
		"trace": {"schemaVersion": 1, "events": [{"frameOffset": 0, "event": {"type": "action", "action": "phase_4_accept", "pressed": true, "strengthMillionths": 1000000}}]},
	}, _now_ms() + 5000)
	assert(replayed.ok and replayed.data.receipt.deterministic and Input.is_action_pressed("phase_4_accept"))
	runtime_input.release_all("replay")
	var expired: Dictionary = await runtime_input.execute({
		"operation": "sequence", "handle": handle, "mode": "deterministic", "timeoutMs": 1,
		"events": [{"frameOffset": 1, "event": {"type": "action", "action": "phase_4_accept", "pressed": true, "strengthMillionths": 1000000}}],
	}, 1)
	assert(expired.code == "TIMEOUT" and paused)
	paused = false

	print("GODOT_MCP_RUNTIME_INPUT_UNIT_OK")
	quit(0)

static func _now_ms() -> int:
	return int(Time.get_unix_time_from_system() * 1000.0)
