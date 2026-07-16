extends SceneTree

const EventFactory = preload("res://addons/godot_mcp/runtime/runtime_input_event_factory.gd")
const InputCoordinates = preload("res://addons/godot_mcp/runtime/runtime_input_coordinates.gd")
const InputState = preload("res://addons/godot_mcp/runtime/runtime_input_state.gd")

func _init() -> void:
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
	assert(InputCoordinates.resolve(game_root, touch.events[0], {"position": {"x": 0, "y": 0}, "viewportPath": "../Escape", "coordinateSpace": "viewport"}).code == "INVALID_REQUEST")
	var not_viewport := Node.new()
	not_viewport.name = "NotViewport"
	game_root.add_child(not_viewport)
	assert(InputCoordinates.resolve(game_root, touch.events[0], {"position": {"x": 0, "y": 0}, "viewportPath": "NotViewport", "coordinateSpace": "viewport"}).code == "TARGET_NOT_FOUND")

	var state := InputState.new()
	state.observe({"type": "action", "action": "phase_4_accept", "pressed": true, "strengthMillionths": 1000000})
	state.observe({"type": "key", "keycode": 65, "physicalKeycode": 0, "unicode": 0, "pressed": true, "echo": false, "modifiers": {"alt": false, "ctrl": false, "meta": false, "shift": false}})
	state.observe({"type": "touch", "position": {"x": 10, "y": 20}, "viewportPath": ".", "coordinateSpace": "viewport", "index": 2, "pressed": true, "canceled": false, "doubleTap": false})
	state.observe({"type": "joypad_motion", "device": 0, "axis": 1, "axisValueMillionths": -500000})
	var releases: Array[Dictionary] = state.release_specs()
	assert(releases.size() == 4)
	assert(releases.any(func(spec: Dictionary) -> bool: return spec.type == "action" and not spec.pressed and spec.strengthMillionths == 0))
	assert(releases.any(func(spec: Dictionary) -> bool: return spec.type == "joypad_motion" and spec.axisValueMillionths == 0))
	assert(state.release_specs().is_empty())

	print("GODOT_MCP_RUNTIME_INPUT_UNIT_OK")
	quit(0)
