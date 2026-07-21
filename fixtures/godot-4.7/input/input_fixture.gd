extends Node2D

@export var delivery_order := ""
@export var event_count := 0
@export var frame_counter := 0
@export var last_kind := ""
@export var action_pressed := false
@export var keycode := 0
@export var mouse_x := 0
@export var mouse_y := 0
@export var mouse_button_pressed := false
@export var scroll_x := 0
@export var scroll_y := 0
@export var active_touch_count := 0
@export var touch_drag_x := 0
@export var touch_drag_y := 0
@export var pan_x := 0
@export var pan_y := 0
@export var magnify_millionths := 0
@export var joy_button_pressed := false
@export var joy_axis_millionths := 0
@export var inherited_reload_key_pressed := false
@export var state_digest := ""
@export var replay_delivery_order := ""
@export var replay_event_count := 0
@export var replay_last_kind := ""
@export var replay_action_pressed := false
@export var replay_keycode := 0
@export var replay_digest := ""

var _active_touches: Dictionary = {}

func _ready() -> void:
	inherited_reload_key_pressed = Input.is_key_pressed(KEY_R)
	_refresh_digest()
	_refresh_replay_digest()

func _process(_delta: float) -> void:
	frame_counter += 1

func _input(event: InputEvent) -> void:
	if event is InputEventAction and String(event.action) == "phase_4_accept":
		action_pressed = event.pressed
		_record("action")
		replay_action_pressed = event.pressed
		_record_replay("action")
	elif event is InputEventKey:
		keycode = int(event.keycode)
		_record("key")
		if event.keycode != KEY_R:
			replay_keycode = int(event.keycode)
			_record_replay("key")
		if event.pressed and event.keycode == KEY_R:
			call_deferred("_reload_scene")
	elif event is InputEventMouseButton:
		mouse_x = roundi(event.position.x)
		mouse_y = roundi(event.position.y)
		match event.button_index:
			MOUSE_BUTTON_WHEEL_LEFT: if event.pressed: scroll_x -= roundi(event.factor)
			MOUSE_BUTTON_WHEEL_RIGHT: if event.pressed: scroll_x += roundi(event.factor)
			MOUSE_BUTTON_WHEEL_UP: if event.pressed: scroll_y -= roundi(event.factor)
			MOUSE_BUTTON_WHEEL_DOWN: if event.pressed: scroll_y += roundi(event.factor)
			_: mouse_button_pressed = event.pressed
		_record("mouse_button")
	elif event is InputEventMouseMotion:
		mouse_x = roundi(event.position.x)
		mouse_y = roundi(event.position.y)
		_record("mouse_motion")
	elif event is InputEventScreenTouch:
		if event.pressed:
			_active_touches[event.index] = true
		else:
			_active_touches.erase(event.index)
		active_touch_count = _active_touches.size()
		_record("touch")
	elif event is InputEventScreenDrag:
		touch_drag_x = roundi(event.position.x)
		touch_drag_y = roundi(event.position.y)
		_record("touch_drag")
	elif event is InputEventPanGesture:
		pan_x = roundi(event.delta.x)
		pan_y = roundi(event.delta.y)
		_record("pan_gesture")
	elif event is InputEventMagnifyGesture:
		magnify_millionths = roundi(event.factor * 1000000.0)
		_record("magnify_gesture")
	elif event is InputEventJoypadButton:
		joy_button_pressed = event.pressed
		_record("joypad_button")
	elif event is InputEventJoypadMotion:
		joy_axis_millionths = roundi(event.axis_value * 1000000.0)
		_record("joypad_motion")

func _record(kind: String) -> void:
	last_kind = kind
	event_count += 1
	delivery_order = kind if delivery_order.is_empty() else "%s,%s" % [delivery_order, kind]
	_refresh_digest()

func _record_replay(kind: String) -> void:
	replay_last_kind = kind
	replay_event_count += 1
	replay_delivery_order = kind if replay_delivery_order.is_empty() else "%s,%s" % [replay_delivery_order, kind]
	_refresh_replay_digest()

func _refresh_digest() -> void:
	state_digest = JSON.stringify([
		delivery_order, action_pressed, keycode, mouse_x, mouse_y, mouse_button_pressed,
		scroll_x, scroll_y, active_touch_count, touch_drag_x, touch_drag_y, pan_x, pan_y,
		magnify_millionths, joy_button_pressed, joy_axis_millionths,
	]).sha256_text()

func _refresh_replay_digest() -> void:
	replay_digest = JSON.stringify([
		replay_delivery_order, replay_event_count, replay_last_kind,
		replay_action_pressed, replay_keycode,
	]).sha256_text()

func _reload_scene() -> void:
	get_tree().change_scene_to_file("res://input/input_fixture.tscn")
