class_name GodotMcpRuntimeInputEventFactory
extends RefCounted

const ONE_MILLION := 1000000.0

static func build(spec: Variant) -> Dictionary:
	if typeof(spec) != TYPE_DICTIONARY:
		return _error("INVALID_REQUEST", "Input event must be an object")
	match String(spec.get("type", "")):
		"action": return _action(spec)
		"key": return _key(spec)
		"mouse_button": return _mouse_button(spec)
		"mouse_motion": return _mouse_motion(spec)
		"scroll": return _scroll(spec)
		"touch": return _touch(spec)
		"touch_drag": return _touch_drag(spec)
		"pan_gesture": return _pan(spec)
		"magnify_gesture": return _magnify(spec)
		"joypad_button": return _joypad_button(spec)
		"joypad_motion": return _joypad_motion(spec)
		_: return _error("INVALID_REQUEST", "Input event type is not allowed")

static func _action(spec: Dictionary) -> Dictionary:
	var invalid := _validate_fields(spec, ["type", "action", "pressed", "strengthMillionths"])
	if not invalid.is_empty(): return invalid
	var action := String(spec.action)
	if action.is_empty() or action.length() > 128:
		return _error("INVALID_REQUEST", "Input action name is invalid")
	if not InputMap.has_action(action):
		return _error("TARGET_NOT_FOUND", "Input action does not exist")
	var strength := _bounded_int(spec.strengthMillionths, 0, 1000000)
	if strength == null: return _error("INVALID_REQUEST", "Input action strength is invalid")
	var event := InputEventAction.new()
	event.action = StringName(action)
	event.pressed = bool(spec.pressed)
	event.strength = float(strength) / ONE_MILLION
	return _ok([event], "global")

static func _key(spec: Dictionary) -> Dictionary:
	var invalid := _validate_fields(spec, ["type", "keycode", "physicalKeycode", "unicode", "pressed", "echo", "modifiers"])
	if not invalid.is_empty(): return invalid
	var keycode := _bounded_int(spec.keycode, 1, 0x7fffffff)
	var physical := _bounded_int(spec.physicalKeycode, 0, 0x7fffffff)
	var unicode := _bounded_int(spec.unicode, 0, 0x10ffff)
	if keycode == null or physical == null or unicode == null:
		return _error("INVALID_REQUEST", "Input key value is invalid")
	var event := InputEventKey.new()
	event.keycode = int(keycode)
	event.physical_keycode = int(physical)
	event.unicode = int(unicode)
	event.pressed = bool(spec.pressed)
	event.echo = bool(spec.echo)
	var modifiers := _apply_modifiers(event, spec.modifiers)
	if not modifiers.is_empty(): return modifiers
	return _ok([event], "global")

static func _mouse_button(spec: Dictionary) -> Dictionary:
	var invalid := _validate_fields(spec, ["type", "position", "viewportPath", "coordinateSpace", "buttonIndex", "pressed", "doubleClick", "factorMillionths", "modifiers"])
	if not invalid.is_empty(): return invalid
	var button := _bounded_int(spec.buttonIndex, 1, 9)
	var factor := _bounded_int(spec.factorMillionths, 0, 100000000)
	if button == null or factor == null: return _error("INVALID_REQUEST", "Mouse button value is invalid")
	var event := InputEventMouseButton.new()
	event.button_index = int(button)
	event.pressed = bool(spec.pressed)
	event.double_click = bool(spec.doubleClick)
	event.factor = float(factor) / ONE_MILLION
	var position := _raw_position(spec)
	if not position.ok: return position
	_set_position(event, position.value)
	var modifiers := _apply_modifiers(event, spec.modifiers)
	if not modifiers.is_empty(): return modifiers
	return _ok([event], "viewport")

static func _mouse_motion(spec: Dictionary) -> Dictionary:
	var invalid := _validate_fields(spec, ["type", "position", "viewportPath", "coordinateSpace", "relative", "velocity", "pressureMillionths", "tiltMillionths", "modifiers"])
	if not invalid.is_empty(): return invalid
	var position := _raw_position(spec)
	var relative := _vector(spec.relative, -8192, 8192)
	var velocity := _vector(spec.velocity, -8192, 8192)
	var tilt := _vector(spec.tiltMillionths, -1000000, 1000000)
	var pressure := _bounded_int(spec.pressureMillionths, 0, 1000000)
	if not position.ok or not relative.ok or not velocity.ok or not tilt.ok or pressure == null:
		return _error("INVALID_REQUEST", "Mouse motion value is invalid")
	var event := InputEventMouseMotion.new()
	_set_position(event, position.value)
	event.relative = relative.value
	event.velocity = velocity.value
	event.pressure = float(pressure) / ONE_MILLION
	event.tilt = tilt.value / ONE_MILLION
	var modifiers := _apply_modifiers(event, spec.modifiers)
	if not modifiers.is_empty(): return modifiers
	return _ok([event], "viewport")

static func _scroll(spec: Dictionary) -> Dictionary:
	var invalid := _validate_fields(spec, ["type", "position", "viewportPath", "coordinateSpace", "delta", "modifiers"])
	if not invalid.is_empty(): return invalid
	var position := _raw_position(spec)
	var delta := _vector(spec.delta, -100, 100)
	if not position.ok or not delta.ok or delta.value == Vector2.ZERO:
		return _error("INVALID_REQUEST", "Scroll delta is invalid")
	var events: Array[InputEvent] = []
	if delta.value.x != 0:
		_append_wheel_pair(events, MOUSE_BUTTON_WHEEL_RIGHT if delta.value.x > 0 else MOUSE_BUTTON_WHEEL_LEFT, absf(delta.value.x), position.value, spec.modifiers)
	if delta.value.y != 0:
		_append_wheel_pair(events, MOUSE_BUTTON_WHEEL_DOWN if delta.value.y > 0 else MOUSE_BUTTON_WHEEL_UP, absf(delta.value.y), position.value, spec.modifiers)
	return _ok(events, "viewport")

static func _touch(spec: Dictionary) -> Dictionary:
	var invalid := _validate_fields(spec, ["type", "position", "viewportPath", "coordinateSpace", "index", "pressed", "canceled", "doubleTap"])
	if not invalid.is_empty(): return invalid
	var index := _bounded_int(spec.index, 0, 9)
	var position := _raw_position(spec)
	if index == null or not position.ok: return _error("INVALID_REQUEST", "Touch value is invalid")
	var event := InputEventScreenTouch.new()
	event.index = int(index)
	event.position = position.value
	event.pressed = bool(spec.pressed)
	event.canceled = bool(spec.canceled)
	event.double_tap = bool(spec.doubleTap)
	return _ok([event], "viewport")

static func _touch_drag(spec: Dictionary) -> Dictionary:
	var invalid := _validate_fields(spec, ["type", "position", "viewportPath", "coordinateSpace", "index", "relative", "velocity", "pressureMillionths", "tiltMillionths"])
	if not invalid.is_empty(): return invalid
	var index := _bounded_int(spec.index, 0, 9)
	var position := _raw_position(spec)
	var relative := _vector(spec.relative, -8192, 8192)
	var velocity := _vector(spec.velocity, -8192, 8192)
	var tilt := _vector(spec.tiltMillionths, -1000000, 1000000)
	var pressure := _bounded_int(spec.pressureMillionths, 0, 1000000)
	if index == null or not position.ok or not relative.ok or not velocity.ok or not tilt.ok or pressure == null:
		return _error("INVALID_REQUEST", "Touch drag value is invalid")
	var event := InputEventScreenDrag.new()
	event.index = int(index)
	event.position = position.value
	event.relative = relative.value
	event.velocity = velocity.value
	event.pressure = float(pressure) / ONE_MILLION
	event.tilt = tilt.value / ONE_MILLION
	return _ok([event], "viewport")

static func _pan(spec: Dictionary) -> Dictionary:
	var invalid := _validate_fields(spec, ["type", "position", "viewportPath", "coordinateSpace", "delta"])
	if not invalid.is_empty(): return invalid
	var position := _raw_position(spec)
	var delta := _vector(spec.delta, -100, 100)
	if not position.ok or not delta.ok: return _error("INVALID_REQUEST", "Pan gesture value is invalid")
	var event := InputEventPanGesture.new()
	event.position = position.value
	event.delta = delta.value
	return _ok([event], "viewport")

static func _magnify(spec: Dictionary) -> Dictionary:
	var invalid := _validate_fields(spec, ["type", "position", "viewportPath", "coordinateSpace", "factorMillionths"])
	if not invalid.is_empty(): return invalid
	var position := _raw_position(spec)
	var factor := _bounded_int(spec.factorMillionths, 10000, 16000000)
	if not position.ok or factor == null: return _error("INVALID_REQUEST", "Magnify gesture value is invalid")
	var event := InputEventMagnifyGesture.new()
	event.position = position.value
	event.factor = float(factor) / ONE_MILLION
	return _ok([event], "viewport")

static func _joypad_button(spec: Dictionary) -> Dictionary:
	var invalid := _validate_fields(spec, ["type", "device", "buttonIndex", "pressed", "pressureMillionths"])
	if not invalid.is_empty(): return invalid
	var device := _bounded_int(spec.device, 0, 7)
	var button := _bounded_int(spec.buttonIndex, 0, 127)
	var pressure := _bounded_int(spec.pressureMillionths, 0, 1000000)
	if device == null or button == null or pressure == null: return _error("INVALID_REQUEST", "Joypad button value is invalid")
	var event := InputEventJoypadButton.new()
	event.device = int(device)
	event.button_index = int(button)
	event.pressed = bool(spec.pressed)
	event.pressure = float(pressure) / ONE_MILLION
	return _ok([event], "global")

static func _joypad_motion(spec: Dictionary) -> Dictionary:
	var invalid := _validate_fields(spec, ["type", "device", "axis", "axisValueMillionths"])
	if not invalid.is_empty(): return invalid
	var device := _bounded_int(spec.device, 0, 7)
	var axis := _bounded_int(spec.axis, 0, 9)
	var value := _bounded_int(spec.axisValueMillionths, -1000000, 1000000)
	if device == null or axis == null or value == null: return _error("INVALID_REQUEST", "Joypad motion value is invalid")
	var event := InputEventJoypadMotion.new()
	event.device = int(device)
	event.axis = int(axis)
	event.axis_value = float(value) / ONE_MILLION
	return _ok([event], "global")

static func _append_wheel_pair(events: Array[InputEvent], button: int, factor: float, position: Vector2, modifiers: Variant) -> void:
	for pressed in [true, false]:
		var event := InputEventMouseButton.new()
		event.button_index = button
		event.pressed = pressed
		event.factor = factor
		_set_position(event, position)
		_apply_modifiers(event, modifiers)
		events.append(event)

static func _apply_modifiers(event: InputEventWithModifiers, value: Variant) -> Dictionary:
	if typeof(value) != TYPE_DICTIONARY or not _validate_fields(value, ["alt", "ctrl", "meta", "shift"]).is_empty():
		return _error("INVALID_REQUEST", "Input modifiers are invalid")
	event.alt_pressed = bool(value.alt)
	event.ctrl_pressed = bool(value.ctrl)
	event.meta_pressed = bool(value.meta)
	event.shift_pressed = bool(value.shift)
	return {}

static func _raw_position(spec: Dictionary) -> Dictionary:
	if String(spec.get("coordinateSpace", "")) not in ["viewport", "normalized", "embedder"]:
		return _error("INVALID_REQUEST", "Input coordinate space is invalid")
	var bounds := [0, 1000000] if String(spec.coordinateSpace) == "normalized" else [-8192, 8192]
	var position := _vector(spec.get("position"), bounds[0], bounds[1])
	if not position.ok: return _error("INVALID_REQUEST", "Input position is invalid")
	return position

static func _vector(value: Variant, minimum: int, maximum: int) -> Dictionary:
	if typeof(value) != TYPE_DICTIONARY or not _validate_fields(value, ["x", "y"]).is_empty():
		return {"ok": false}
	var x := _bounded_int(value.x, minimum, maximum)
	var y := _bounded_int(value.y, minimum, maximum)
	if x == null or y == null: return {"ok": false}
	return {"ok": true, "value": Vector2(float(x), float(y))}

static func _bounded_int(value: Variant, minimum: int, maximum: int) -> Variant:
	if typeof(value) not in [TYPE_INT, TYPE_FLOAT]: return null
	var numeric := float(value)
	if not is_finite(numeric) or numeric != floor(numeric) or numeric < minimum or numeric > maximum:
		return null
	return int(numeric)

static func _validate_fields(value: Dictionary, allowed: Array[String]) -> Dictionary:
	for key: Variant in value.keys():
		if String(key) not in allowed:
			return _error("INVALID_REQUEST", "Input event contains an unsupported field")
	for field in allowed:
		if not value.has(field):
			return _error("INVALID_REQUEST", "Input event is missing a required field")
	return {}

static func _set_position(event: InputEventMouse, position: Vector2) -> void:
	event.position = position
	event.global_position = position

static func _ok(events: Array, route: String) -> Dictionary:
	return {"ok": true, "events": events, "route": route}

static func _error(code: String, message: String) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": false}
