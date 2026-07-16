extends Node

@export var event_count := 0
@export var last_kind := ""
@export var last_x := 0
@export var last_y := 0

func _input(event: InputEvent) -> void:
	if event is InputEventMouse or event is InputEventScreenTouch or event is InputEventScreenDrag or event is InputEventGesture:
		last_x = roundi(event.position.x)
		last_y = roundi(event.position.y)
		event_count += 1
		last_kind = event.get_class()
