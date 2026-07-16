class_name GodotMcpRuntimeInputState
extends RefCounted

var _actions: Dictionary = {}
var _keys: Dictionary = {}
var _mouse_buttons: Dictionary = {}
var _touches: Dictionary = {}
var _joy_buttons: Dictionary = {}
var _joy_axes: Dictionary = {}

func observe(spec: Dictionary) -> void:
	match String(spec.get("type", "")):
		"action": _set_or_erase(_actions, String(spec.get("action", "")), spec, bool(spec.get("pressed", false)))
		"key": _set_or_erase(_keys, "%s:%s" % [spec.get("keycode", 0), spec.get("physicalKeycode", 0)], spec, bool(spec.get("pressed", false)))
		"mouse_button": _set_or_erase(_mouse_buttons, "%s:%s" % [spec.get("viewportPath", "."), spec.get("buttonIndex", 0)], spec, bool(spec.get("pressed", false)))
		"mouse_motion": _update_mouse_positions(spec)
		"touch": _set_or_erase(_touches, str(spec.get("index", -1)), spec, bool(spec.get("pressed", false)))
		"touch_drag": _update_touch_position(spec)
		"joypad_button": _set_or_erase(_joy_buttons, "%s:%s" % [spec.get("device", 0), spec.get("buttonIndex", 0)], spec, bool(spec.get("pressed", false)))
		"joypad_motion": _set_or_erase(_joy_axes, "%s:%s" % [spec.get("device", 0), spec.get("axis", 0)], spec, int(spec.get("axisValueMillionths", 0)) != 0)

func release_specs() -> Array[Dictionary]:
	var releases: Array[Dictionary] = []
	_append_releases(releases, _actions, func(spec: Dictionary) -> void:
		spec.pressed = false
		spec.strengthMillionths = 0
	)
	_append_releases(releases, _keys, func(spec: Dictionary) -> void:
		spec.pressed = false
		spec.echo = false
	)
	_append_releases(releases, _mouse_buttons, func(spec: Dictionary) -> void:
		spec.pressed = false
		spec.doubleClick = false
	)
	_append_releases(releases, _touches, func(spec: Dictionary) -> void:
		spec.pressed = false
		spec.canceled = true
	)
	_append_releases(releases, _joy_buttons, func(spec: Dictionary) -> void:
		spec.pressed = false
		spec.pressureMillionths = 0
	)
	_append_releases(releases, _joy_axes, func(spec: Dictionary) -> void:
		spec.axisValueMillionths = 0
	)
	return releases

func _append_releases(output: Array[Dictionary], held: Dictionary, mutate: Callable) -> void:
	var keys: Array = held.keys()
	keys.sort()
	for key: Variant in keys:
		var spec: Dictionary = held[key].duplicate(true)
		mutate.call(spec)
		output.append(spec)
	held.clear()

static func _set_or_erase(held: Dictionary, key: String, spec: Dictionary, active: bool) -> void:
	if active:
		held[key] = spec.duplicate(true)
	else:
		held.erase(key)

func _update_mouse_positions(spec: Dictionary) -> void:
	for key: Variant in _mouse_buttons.keys():
		var held: Dictionary = _mouse_buttons[key]
		if String(held.get("viewportPath", ".")) != String(spec.get("viewportPath", ".")):
			continue
		held.position = spec.position.duplicate(true)
		held.coordinateSpace = String(spec.coordinateSpace)
		_mouse_buttons[key] = held

func _update_touch_position(spec: Dictionary) -> void:
	var key := str(spec.get("index", -1))
	if not _touches.has(key): return
	var held: Dictionary = _touches[key]
	held.position = spec.position.duplicate(true)
	held.viewportPath = String(spec.viewportPath)
	held.coordinateSpace = String(spec.coordinateSpace)
	_touches[key] = held
