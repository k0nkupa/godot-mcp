extends SceneTree

const VISUAL_FIXTURE = preload("res://visual/visual_fixture.tscn")

func _init() -> void:
	var fixture := VISUAL_FIXTURE.instantiate()
	root.add_child(fixture)
	await process_frame
	assert(fixture.mode == "stable")
	assert(fixture.input_count == 0)
	assert(not fixture.intentional_delta)
	assert(fixture.get_node("Quadrants/TopLeft").position == Vector2(0, 0))
	assert(fixture.get_node("Quadrants/BottomRight").size == Vector2(160, 90))
	assert(fixture.get_node("AnimatedMaskTarget").size == Vector2(12, 12))
	var accept := InputEventAction.new()
	accept.action = "ui_accept"
	accept.pressed = true
	fixture._input(accept)
	assert(fixture.input_count == 1)
	fixture.intentional_delta = true
	await process_frame
	assert(fixture.get_node("IntentionalDelta").visible)
	assert(fixture.get_node("IntentionalDelta").size == Vector2(10, 10))
	print("PHASE8_VISUAL_FIXTURE_OK")
	quit()
