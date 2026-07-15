extends Node2D

signal milestone(value: int)

@export var fixture_name := "phase-3-runtime"
@export var frame_counter := 0
@export var physics_counter := 0
@export var phase := "starting"

func _ready() -> void:
	add_to_group("runtime_fixture")
	print("phase-3 runtime ready")

func _process(_delta: float) -> void:
	frame_counter += 1
	$Accent.position.x = 80.0 + float(frame_counter % 120)
	if frame_counter % 5 == 0:
		milestone.emit(frame_counter)
	if frame_counter >= 10:
		phase = "ready"

func _physics_process(_delta: float) -> void:
	physics_counter += 1
