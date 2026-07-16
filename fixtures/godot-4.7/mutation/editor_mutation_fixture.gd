@tool
extends Node2D

signal fixture_event(value: int)

var last_fixture_value := 0

func _on_fixture_event(value: int) -> void:
	last_fixture_value = value
