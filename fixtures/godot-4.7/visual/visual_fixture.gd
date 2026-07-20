extends Node2D

@export var mode := "stable":
	set(value):
		mode = value
		_refresh_labels()
@export var input_count := 0:
	set(value):
		input_count = value
		_refresh_labels()
@export var intentional_delta := false:
	set(value):
		intentional_delta = value
		var block := get_node_or_null("IntentionalDelta") as ColorRect
		if block != null:
			block.visible = value

func _ready() -> void:
	_refresh_labels()
	$IntentionalDelta.visible = intentional_delta

func _process(_delta: float) -> void:
	# This block deliberately varies frame-to-frame and is the documented mask target.
	$AnimatedMaskTarget.color = Color("68d391") if Engine.get_process_frames() % 2 == 0 else Color("f6ad55")

func _input(event: InputEvent) -> void:
	if event is InputEventAction and event.action == &"ui_accept" and event.pressed:
		input_count += 1
		mode = "accepted"
		get_viewport().set_input_as_handled()

func _refresh_labels() -> void:
	var mode_label := get_node_or_null("ModeLabel") as Label
	var count_label := get_node_or_null("InputCountLabel") as Label
	if mode_label != null:
		mode_label.text = "mode:%s" % mode
	if count_label != null:
		count_label.text = "inputs:%d" % input_count
