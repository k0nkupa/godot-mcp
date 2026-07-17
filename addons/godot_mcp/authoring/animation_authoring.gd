@tool
class_name GodotMcpAnimationAuthoring
extends RefCounted

const ResourceLocator = preload("res://addons/godot_mcp/authoring/resource_locator.gd")
const VariantDecoder = preload("res://addons/godot_mcp/mutation/editor_variant_decoder.gd")
const TRACK_IDS_META := "_godot_mcp_track_ids"

static func prepare(step_value: Dictionary, context: Dictionary) -> Dictionary:
	var step := step_value.duplicate(true)
	var operation := String(step.get("operation", ""))
	if operation == "configure_animation_tree": return _prepare_tree(step, context)
	var located := ResourceLocator.resolve(step.get("target", {}), context.get("filesystem"), context.get("rootResource"))
	if not located.ok: return located
	if operation in ["upsert_animation", "remove_animation"]: return _prepare_library(step, located)
	if operation in ["upsert_animation_track", "remove_animation_track", "upsert_animation_key", "remove_animation_key"]: return _prepare_animation(step, located, context)
	return _error("INVALID_REQUEST", "Unsupported animation authoring operation")

static func apply_step(step: Dictionary, forward: bool) -> void:
	var operation := String(step.operation)
	if operation in ["upsert_animation", "remove_animation"]: _apply_library(step, forward)
	elif operation in ["upsert_animation_track", "remove_animation_track"]: _apply_track(step, forward)
	elif operation in ["upsert_animation_key", "remove_animation_key"]: _apply_key(step, forward)
	elif operation == "configure_animation_tree":
		var tree: AnimationTree = step._tree
		var values: Dictionary = step._after if forward else step._before
		for property in values: tree.set(property, values[property])

static func _prepare_library(step: Dictionary, located: Dictionary) -> Dictionary:
	if not located.resource is AnimationLibrary: return _error("INVALID_REQUEST", "Animation operation requires an AnimationLibrary")
	var library: AnimationLibrary = located.resource
	var name := String(step.get("animationName", ""))
	step._library = library; step._had_before = library.has_animation(name); step._before = library.get_animation(name) if step._had_before else null
	if String(step.operation) == "upsert_animation":
		var animation := Animation.new(); animation.length = float(step.length)
		animation.loop_mode = {"none": Animation.LOOP_NONE, "linear": Animation.LOOP_LINEAR, "pingpong": Animation.LOOP_PINGPONG}[String(step.loopMode)]
		step._after = animation
	return {"ok": true, "step": step, "identity": located.identity}

static func _apply_library(step: Dictionary, forward: bool) -> void:
	var library: AnimationLibrary = step._library
	var name := String(step.animationName)
	var should_set := (String(step.operation) == "upsert_animation") if forward else bool(step._had_before)
	if library.has_animation(name): library.remove_animation(name)
	if should_set: library.add_animation(name, step._after if forward else step._before)

static func _prepare_animation(step: Dictionary, located: Dictionary, context: Dictionary) -> Dictionary:
	if not located.resource is Animation: return _error("INVALID_REQUEST", "Track operation requires an Animation resource")
	var animation: Animation = located.resource
	var track_id := String(step.get("trackId", ""))
	var track_map := _track_map(animation)
	var track_index := int(track_map.get(track_id, -1))
	var operation := String(step.operation)
	if operation in ["remove_animation_track", "upsert_animation_key", "remove_animation_key"] and (track_index < 0 or track_index >= animation.get_track_count()):
		return _error("TARGET_NOT_FOUND", "Animation track ID was not found")
	step._animation = animation; step._track_id = track_id; step._track_index = track_index
	if operation in ["upsert_animation_track", "remove_animation_track"]:
		step._had_before = track_index >= 0 and track_index < animation.get_track_count()
		step._before = _capture_track(animation, track_index) if step._had_before else null
		if operation == "upsert_animation_track":
			var track_type := _track_type(String(step.trackType))
			if track_type < 0: return _error("INVALID_REQUEST", "Animation track type is unsupported")
			var path := NodePath(String(step.trackPath))
			if path.is_empty() or path.is_absolute(): return _error("INVALID_REQUEST", "Animation track path must be relative")
			step._after = {"type": track_type, "path": path, "keys": []}
	else:
		var time := float(step.keyTime)
		var key_index := animation.track_find_key(track_index, time, Animation.FIND_MODE_EXACT)
		step._key_index = key_index; step._had_before = key_index >= 0
		step._before = {"value": animation.track_get_key_value(track_index, key_index), "transition": animation.track_get_key_transition(track_index, key_index)} if step._had_before else null
		if operation == "upsert_animation_key":
			var decoded := VariantDecoder.decode(step.get("value"), context.get("filesystem"))
			if not decoded.ok: return decoded
			step._after = {"value": decoded.value, "transition": float(step.get("transition", 1.0))}
	return {"ok": true, "step": step, "identity": located.identity}

static func _apply_track(step: Dictionary, forward: bool) -> void:
	var animation: Animation = step._animation
	var track_id := String(step._track_id)
	var track_map := _track_map(animation)
	var current := int(track_map.get(track_id, -1))
	if current >= 0 and current < animation.get_track_count():
		animation.remove_track(current); track_map = _shift_after_remove(track_map, current); track_map.erase(track_id)
	var should_set := (String(step.operation) == "upsert_animation_track") if forward else bool(step._had_before)
	if should_set:
		var captured: Dictionary = step._after if forward else step._before
		var index := int(step._track_index) if bool(step._had_before) else animation.get_track_count()
		index = clampi(index, 0, animation.get_track_count())
		track_map = _shift_before_insert(track_map, index)
		animation.add_track(int(captured.type), index); animation.track_set_path(index, captured.path)
		for key in captured.keys: animation.track_insert_key(index, key.time, key.value, key.transition)
		track_map[track_id] = index
	animation.set_meta(TRACK_IDS_META, track_map)

static func _apply_key(step: Dictionary, forward: bool) -> void:
	var animation: Animation = step._animation
	var track_index := int(_track_map(animation).get(String(step._track_id), -1))
	if track_index < 0: return
	var time := float(step.keyTime)
	var current := animation.track_find_key(track_index, time, Animation.FIND_MODE_EXACT)
	if current >= 0: animation.track_remove_key(track_index, current)
	var should_set := (String(step.operation) == "upsert_animation_key") if forward else bool(step._had_before)
	if should_set:
		var captured: Dictionary = step._after if forward else step._before
		animation.track_insert_key(track_index, time, captured.value, float(captured.transition))

static func _prepare_tree(step: Dictionary, context: Dictionary) -> Dictionary:
	var root: Node = context.get("root")
	if root == null: return _error("TARGET_NOT_FOUND", "Open scene root is unavailable")
	var node := root.get_node_or_null(NodePath(String(step.get("nodePath", ""))))
	if not node is AnimationTree: return _error("TARGET_NOT_FOUND", "AnimationTree target was not found")
	var before := {}; var after := {}
	if step.has("active"): before.active = node.active; after.active = bool(step.active)
	if step.has("processCallback"):
		before.callback_mode_process = node.callback_mode_process
		after.callback_mode_process = {"physics": AnimationTree.ANIMATION_PROCESS_PHYSICS, "idle": AnimationTree.ANIMATION_PROCESS_IDLE, "manual": AnimationTree.ANIMATION_PROCESS_MANUAL}[String(step.processCallback)]
	if step.has("rootMotionTrack"): before.root_motion_track = node.root_motion_track; after.root_motion_track = NodePath(String(step.rootMotionTrack))
	if step.has("treeRoot"):
		var decoded := VariantDecoder.decode(step.treeRoot, context.get("filesystem"))
		if not decoded.ok: return decoded
		if not decoded.value is AnimationRootNode: return _error("INVALID_REQUEST", "AnimationTree root must be an AnimationRootNode")
		before.tree_root = node.tree_root; after.tree_root = decoded.value
	var parameters: Dictionary = step.get("parameters", {})
	for property in parameters:
		if not _has_property(node, property): return _error("TARGET_NOT_FOUND", "AnimationTree parameter path was not found")
		var decoded := VariantDecoder.decode(parameters[property], context.get("filesystem"))
		if not decoded.ok: return decoded
		before[property] = node.get(property); after[property] = decoded.value
	step._tree = node; step._before = before; step._after = after
	return {"ok": true, "step": step}

static func _track_map(animation: Animation) -> Dictionary:
	var value: Variant = animation.get_meta(TRACK_IDS_META, {})
	return value.duplicate(true) if typeof(value) == TYPE_DICTIONARY else {}

static func _capture_track(animation: Animation, index: int) -> Dictionary:
	var keys: Array[Dictionary] = []
	for key_index in animation.track_get_key_count(index):
		keys.append({"time": animation.track_get_key_time(index, key_index), "value": animation.track_get_key_value(index, key_index), "transition": animation.track_get_key_transition(index, key_index)})
	return {"type": animation.track_get_type(index), "path": animation.track_get_path(index), "keys": keys}

static func _shift_after_remove(track_map: Dictionary, removed: int) -> Dictionary:
	for id in track_map:
		if int(track_map[id]) > removed: track_map[id] = int(track_map[id]) - 1
	return track_map

static func _shift_before_insert(track_map: Dictionary, inserted: int) -> Dictionary:
	for id in track_map:
		if int(track_map[id]) >= inserted: track_map[id] = int(track_map[id]) + 1
	return track_map

static func _track_type(name: String) -> int:
	return {"value": Animation.TYPE_VALUE, "position_3d": Animation.TYPE_POSITION_3D, "rotation_3d": Animation.TYPE_ROTATION_3D, "scale_3d": Animation.TYPE_SCALE_3D, "blend_shape": Animation.TYPE_BLEND_SHAPE, "method": Animation.TYPE_METHOD, "bezier": Animation.TYPE_BEZIER, "audio": Animation.TYPE_AUDIO, "animation": Animation.TYPE_ANIMATION}.get(name, -1)

static func _has_property(object: Object, property_name: String) -> bool:
	return object.get_property_list().any(func(property: Dictionary) -> bool: return String(property.name) == property_name)

static func _error(code: String, message: String) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": false}
