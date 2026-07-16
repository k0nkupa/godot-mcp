class_name GodotMcpRuntimeInputCoordinates
extends RefCounted

const ONE_MILLION := 1000000.0

static func resolve(game_root: Node, event: InputEvent, target: Variant) -> Dictionary:
	if not is_instance_valid(game_root) or typeof(target) != TYPE_DICTIONARY:
		return _error("INVALID_REQUEST", "Input coordinate target is invalid")
	for field in ["position", "viewportPath", "coordinateSpace"]:
		if not target.has(field): return _error("INVALID_REQUEST", "Input coordinate target is incomplete")
	var viewport_path := String(target.viewportPath)
	if not path_is_allowed(viewport_path): return _error("INVALID_REQUEST", "Input viewport path is invalid")
	var viewport: Viewport = game_root.get_viewport() if viewport_path == "." else game_root.get_node_or_null(NodePath(viewport_path)) as Viewport
	if viewport == null or not viewport.is_inside_tree(): return _error("TARGET_NOT_FOUND", "Input viewport was not found")
	if typeof(target.position) != TYPE_DICTIONARY or target.position.keys().size() != 2 or not target.position.has("x") or not target.position.has("y"):
		return _error("INVALID_REQUEST", "Input position is invalid")
	var space := String(target.coordinateSpace)
	var position := Vector2(float(target.position.x), float(target.position.y))
	var in_local_coords := true
	if space == "normalized":
		if position.x < 0 or position.x > 1000000 or position.y < 0 or position.y > 1000000:
			return _error("INVALID_REQUEST", "Normalized input position is invalid")
		position = viewport.get_visible_rect().size * position / ONE_MILLION
	elif space == "embedder":
		in_local_coords = false
	elif space != "viewport":
		return _error("INVALID_REQUEST", "Input coordinate space is invalid")
	if event is InputEventMouse:
		event.position = position
		event.global_position = position
	elif event is InputEventScreenTouch or event is InputEventScreenDrag or event is InputEventGesture:
		event.position = position
	else:
		return _error("INVALID_REQUEST", "Input event has no viewport coordinates")
	var visible := viewport.get_visible_rect().size
	return {
		"ok": true,
		"viewport": viewport,
		"events": [event],
		"inLocalCoords": in_local_coords,
		"receipt": {
			"viewportPath": viewport_path,
			"coordinateSpace": space,
			"visibleWidth": roundi(visible.x),
			"visibleHeight": roundi(visible.y),
		},
	}

static func path_is_allowed(path: String) -> bool:
	return not path.is_empty() and not path.is_absolute_path() and ":" not in path and not _contains_nul(path) and ".." not in path.split("/")

static func _contains_nul(value: String) -> bool:
	for index in value.length():
		if value.unicode_at(index) == 0:
			return true
	return false

static func _error(code: String, message: String) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": false}
