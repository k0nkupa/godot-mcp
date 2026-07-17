@tool
class_name GodotMcpTileAuthoring
extends RefCounted

static func prepare(step_value: Dictionary, context: Dictionary) -> Dictionary:
	var step := step_value.duplicate(true)
	var root: Node = context.get("root")
	if root == null: return _error("TARGET_NOT_FOUND", "Open scene root is unavailable")
	var node := root.get_node_or_null(NodePath(String(step.get("nodePath", ""))))
	if not node is TileMapLayer: return _error("TARGET_NOT_FOUND", "TileMapLayer target was not found")
	var entries: Array = step.get("cells", []) if String(step.operation) == "set_tile_cells" else step.get("coordinates", [])
	if entries.is_empty() or entries.size() > 4096: return _error("PAYLOAD_TOO_LARGE", "Tile operation must contain 1 to 4096 coordinates")
	var seen := {}; var before: Array[Dictionary] = []; var after: Array[Dictionary] = []
	for entry_value in entries:
		var coordinates_value: Dictionary = entry_value.coordinates if String(step.operation) == "set_tile_cells" else entry_value
		var coordinates := Vector2i(int(coordinates_value.x), int(coordinates_value.y))
		var key := "%s,%s" % [coordinates.x, coordinates.y]
		if seen.has(key): return _error("CONFLICT", "Tile operation contains duplicate coordinates")
		seen[key] = true
		before.append(_cell(node, coordinates))
		if String(step.operation) == "set_tile_cells":
			var source_id := int(entry_value.sourceId)
			if node.tile_set == null or not node.tile_set.has_source(source_id): return _error("TARGET_NOT_FOUND", "Tile source was not found")
			after.append({"coordinates": coordinates, "sourceId": source_id, "atlasCoordinates": Vector2i(entry_value.atlasCoordinates.x, entry_value.atlasCoordinates.y), "alternativeTile": int(entry_value.alternativeTile)})
		else: after.append({"coordinates": coordinates, "sourceId": -1, "atlasCoordinates": Vector2i(-1, -1), "alternativeTile": -1})
	step._layer = node; step._before = before; step._after = after
	return {"ok": true, "step": step}

static func apply_step(step: Dictionary, forward: bool) -> void:
	var layer: TileMapLayer = step._layer
	for cell in step._after if forward else step._before:
		if int(cell.sourceId) < 0: layer.erase_cell(cell.coordinates)
		else: layer.set_cell(cell.coordinates, int(cell.sourceId), cell.atlasCoordinates, int(cell.alternativeTile))

static func _cell(layer: TileMapLayer, coordinates: Vector2i) -> Dictionary:
	return {"coordinates": coordinates, "sourceId": layer.get_cell_source_id(coordinates), "atlasCoordinates": layer.get_cell_atlas_coords(coordinates), "alternativeTile": layer.get_cell_alternative_tile(coordinates)}

static func _error(code: String, message: String) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": false}
