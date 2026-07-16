extends Node

@export var phase := "source"

func _ready() -> void:
	await get_tree().create_timer(0.5).timeout
	get_tree().change_scene_to_file("res://runtime/runtime_transition.tscn")
