@tool
extends Node2D

signal fixture_event(value: int)

@export var fixture_resource: Resource
@export var display_label := "phase-2-2d"
@export var api_token := "fixture-secret"

func _enter_tree() -> void:
	push_warning("phase-2 fixture diagnostic")
