extends Node

signal departing

func _process(_delta: float) -> void:
	if not departing.get_connections().is_empty():
		departing.emit()
		free()
