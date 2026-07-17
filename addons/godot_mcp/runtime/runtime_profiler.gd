class_name GodotMcpRuntimeProfiler
extends RefCounted

const CanonicalJson = preload("res://addons/godot_mcp/bridge/canonical_json.gd")
const PROFILER_NAME := &"godot_mcp_phase7"
const MAX_SAMPLES := 2048
const MAX_EVIDENCE_BYTES := 4 * 1024 * 1024
const MAX_METRICS := 128
const ALLOWED_GROUPS := ["frame", "memory", "objects", "rendering", "physics", "audio", "navigation", "pipeline", "custom"]
const GROUP_MONITORS := {
	"frame": [
		["fps", Performance.TIME_FPS],
		["process_seconds", Performance.TIME_PROCESS],
		["physics_process_seconds", Performance.TIME_PHYSICS_PROCESS],
	],
	"memory": [
		["static_bytes", Performance.MEMORY_STATIC],
		["static_max_bytes", Performance.MEMORY_STATIC_MAX],
		["message_buffer_max_bytes", Performance.MEMORY_MESSAGE_BUFFER_MAX],
	],
	"objects": [
		["objects", Performance.OBJECT_COUNT],
		["resources", Performance.OBJECT_RESOURCE_COUNT],
		["nodes", Performance.OBJECT_NODE_COUNT],
		["orphan_nodes", Performance.OBJECT_ORPHAN_NODE_COUNT],
	],
	"rendering": [
		["objects_in_frame", Performance.RENDER_TOTAL_OBJECTS_IN_FRAME],
		["primitives_in_frame", Performance.RENDER_TOTAL_PRIMITIVES_IN_FRAME],
		["draw_calls_in_frame", Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME],
		["video_memory_bytes", Performance.RENDER_VIDEO_MEM_USED],
		["texture_memory_bytes", Performance.RENDER_TEXTURE_MEM_USED],
		["buffer_memory_bytes", Performance.RENDER_BUFFER_MEM_USED],
	],
	"physics": [
		["2d_active_objects", Performance.PHYSICS_2D_ACTIVE_OBJECTS],
		["2d_collision_pairs", Performance.PHYSICS_2D_COLLISION_PAIRS],
		["2d_islands", Performance.PHYSICS_2D_ISLAND_COUNT],
		["3d_active_objects", Performance.PHYSICS_3D_ACTIVE_OBJECTS],
		["3d_collision_pairs", Performance.PHYSICS_3D_COLLISION_PAIRS],
		["3d_islands", Performance.PHYSICS_3D_ISLAND_COUNT],
	],
	"audio": [["output_latency_seconds", Performance.AUDIO_OUTPUT_LATENCY]],
	"navigation": [
		["process_seconds", Performance.TIME_NAVIGATION_PROCESS],
		["active_maps", Performance.NAVIGATION_ACTIVE_MAPS],
		["regions", Performance.NAVIGATION_REGION_COUNT],
		["agents", Performance.NAVIGATION_AGENT_COUNT],
		["links", Performance.NAVIGATION_LINK_COUNT],
		["polygons", Performance.NAVIGATION_POLYGON_COUNT],
		["edges", Performance.NAVIGATION_EDGE_COUNT],
		["edge_merges", Performance.NAVIGATION_EDGE_MERGE_COUNT],
		["edge_connections", Performance.NAVIGATION_EDGE_CONNECTION_COUNT],
		["free_edges", Performance.NAVIGATION_EDGE_FREE_COUNT],
		["obstacles", Performance.NAVIGATION_OBSTACLE_COUNT],
	],
	"pipeline": [
		["canvas_compilations", Performance.PIPELINE_COMPILATIONS_CANVAS],
		["mesh_compilations", Performance.PIPELINE_COMPILATIONS_MESH],
		["surface_compilations", Performance.PIPELINE_COMPILATIONS_SURFACE],
		["draw_compilations", Performance.PIPELINE_COMPILATIONS_DRAW],
		["specialization_compilations", Performance.PIPELINE_COMPILATIONS_SPECIALIZATION],
	],
}

class RuntimeEngineProfiler extends EngineProfiler:
	var _owner_ref: WeakRef

	func _init(owner: Object) -> void:
		_owner_ref = weakref(owner)

	func _tick(frame_time: float, process_time: float, physics_time: float, physics_frame_time: float) -> void:
		var owner := _owner_ref.get_ref()
		if owner != null:
			owner.record_engine_tick(frame_time, process_time, physics_time, physics_frame_time)

var _job: Dictionary = {}
var _series: Dictionary = {}
var _raw_samples: Array[Dictionary] = []
var _raw_bytes := 0
var _tick_values: Dictionary = {}
var _engine_profiler: EngineProfiler
var _profiler_registered := false
var _rendering_device: RenderingDevice

func snapshot(groups: Array) -> Dictionary:
	var valid := _validate_groups(groups, 9)
	if not valid.ok:
		return valid
	var unavailable: Array[String] = []
	var output_groups: Dictionary = {}
	for group: String in valid.groups:
		if group == "custom":
			output_groups[group] = _custom_monitors(unavailable)
		else:
			var values: Dictionary = {}
			for monitor: Array in GROUP_MONITORS.get(group, []):
				var value := float(Performance.get_monitor(int(monitor[1])))
				if is_finite(value):
					values[String(monitor[0])] = value
				else:
					unavailable.append("%s.%s is not finite" % [group, String(monitor[0])])
			output_groups[group] = values
	return {"ok": true, "data": {
		"schemaVersion": 1,
		"frame": Engine.get_process_frames(),
		"monotonicUsec": Time.get_ticks_usec(),
		"engine": _engine_metadata(),
		"groups": output_groups,
		"unavailable": unavailable.slice(0, 128),
		"gpuTimestamps": _gpu_timestamps(),
	}}

func start(input: Dictionary) -> Dictionary:
	if not _job.is_empty() and String(_job.get("state", "")) == "running":
		return _error("CONFLICT", "A runtime profile job is already active")
	var duration_ms := int(input.get("durationMs", 0))
	var interval_frames := int(input.get("intervalFrames", 0))
	var groups_value: Variant = input.get("groups", null)
	if duration_ms < 100 or duration_ms > 30000 or interval_frames < 1 or interval_frames > 120 or typeof(groups_value) != TYPE_ARRAY:
		return _error("INVALID_REQUEST", "Runtime profile bounds are invalid")
	var valid := _validate_groups(groups_value, 8)
	if not valid.ok:
		return valid
	if typeof(input.get("retainRaw", false)) != TYPE_BOOL:
		return _error("INVALID_REQUEST", "retainRaw must be boolean")
	_unregister_engine_profiler()
	_series.clear()
	_raw_samples.clear()
	_raw_bytes = 0
	_tick_values.clear()
	var now := Time.get_ticks_usec()
	_job = {
		"jobToken": _opaque_token(),
		"state": "running",
		"complete": false,
		"startedMonotonicUsec": now,
		"finishedMonotonicUsec": 0,
		"startFrame": Engine.get_process_frames(),
		"endFrame": Engine.get_process_frames(),
		"requestedDurationMs": duration_ms,
		"intervalFrames": interval_frames,
		"groups": valid.groups,
		"retainRaw": bool(input.get("retainRaw", false)),
		"observedSamples": 0,
		"invalidSamples": 0,
		"droppedSamples": 0,
		"terminalReason": "",
	}
	_register_engine_profiler()
	_rendering_device = RenderingServer.get_rendering_device()
	if _rendering_device != null:
		_rendering_device.capture_timestamp("godot_mcp_profile_start")
	return {"ok": true, "data": _status_receipt()}

func process_frame() -> void:
	if _job.is_empty() or String(_job.get("state", "")) != "running":
		return
	var elapsed_usec := Time.get_ticks_usec() - int(_job.startedMonotonicUsec)
	if elapsed_usec >= int(_job.requestedDurationMs) * 1000:
		_finalize("completed", true, "")
		return
	var frame := Engine.get_process_frames()
	if (frame - int(_job.startFrame)) % int(_job.intervalFrames) != 0:
		return
	var sampled := snapshot(_job.groups)
	if not sampled.ok:
		_finalize("failed", false, String(sampled.get("message", "Profile sampling failed")))
		return
	var values := _flatten_values(sampled.data.groups)
	for key: String in _tick_values.keys():
		if values.size() >= MAX_METRICS:
			break
		values[key] = float(_tick_values[key])
	_job.observedSamples = int(_job.observedSamples) + 1
	if values.is_empty():
		_job.invalidSamples = int(_job.invalidSamples) + 1
		return
	_record_aggregates(values, int(_job.observedSamples))
	if bool(_job.retainRaw):
		_retain_raw({"frame": frame, "monotonicUsec": Time.get_ticks_usec(), "values": values}, int(_job.observedSamples))
	if _rendering_device != null:
		_rendering_device.capture_timestamp("godot_mcp_profile_%d" % int(_job.observedSamples))

func status(job_token: String) -> Dictionary:
	if not _token_matches(job_token):
		return _error("STALE_HANDLE", "Profile job token is stale or unknown")
	return {"ok": true, "data": _status_receipt()}

func cancel(job_token: String) -> Dictionary:
	if not _token_matches(job_token):
		return _error("STALE_HANDLE", "Profile job token is stale or unknown")
	if String(_job.state) == "running":
		_finalize("cancelled", false, "Profile cancelled by request")
	return {"ok": true, "data": _status_receipt()}

func result(job_token: String) -> Dictionary:
	if not _token_matches(job_token):
		return _error("STALE_HANDLE", "Profile job token is stale or unknown")
	if String(_job.state) == "running":
		return _error("CONFLICT", "Profile evidence is not terminal")
	return {"ok": true, "data": {"state": String(_job.state), "evidence": _job.evidence.duplicate(true)}}

func clear() -> void:
	if not _job.is_empty() and String(_job.get("state", "")) == "running":
		_finalize("cancelled", false, "Runtime profiler cleared")
	_unregister_engine_profiler()
	_job.clear()
	_series.clear()
	_raw_samples.clear()
	_raw_bytes = 0
	_tick_values.clear()
	_rendering_device = null

func record_engine_tick(frame_time: float, process_time: float, physics_time: float, physics_frame_time: float) -> void:
	for entry: Array in [
		["profiler.frame_seconds", frame_time],
		["profiler.process_seconds", process_time],
		["profiler.physics_seconds", physics_time],
		["profiler.physics_frame_seconds", physics_frame_time],
	]:
		if is_finite(float(entry[1])):
			_tick_values[String(entry[0])] = float(entry[1])

static func retention_slot(observed_count: int, capacity: int) -> int:
	if observed_count < 1 or capacity < 1:
		return -1
	if observed_count <= capacity:
		return observed_count - 1
	var candidate := int((observed_count * 1103515245 + 12345) & 0x7fffffff) % observed_count
	return candidate if candidate < capacity else -1

func _record_aggregates(values: Dictionary, observed_count: int) -> void:
	var keys: Array = values.keys()
	keys.sort()
	for key_value: Variant in keys:
		var key := String(key_value)
		var series: Array = _series.get(key, [])
		var slot := retention_slot(observed_count, MAX_SAMPLES)
		if slot < 0:
			continue
		if slot < series.size():
			series[slot] = float(values[key])
		else:
			series.append(float(values[key]))
		_series[key] = series

func _retain_raw(sample: Dictionary, observed_count: int) -> void:
	var encoded_bytes := JSON.stringify(sample).to_utf8_buffer().size()
	if encoded_bytes > MAX_EVIDENCE_BYTES:
		_job.droppedSamples = int(_job.droppedSamples) + 1
		return
	var slot := retention_slot(observed_count, MAX_SAMPLES)
	if slot < 0:
		_job.droppedSamples = int(_job.droppedSamples) + 1
		return
	if slot < _raw_samples.size():
		var old_bytes := JSON.stringify(_raw_samples[slot]).to_utf8_buffer().size()
		if _raw_bytes - old_bytes + encoded_bytes > MAX_EVIDENCE_BYTES:
			_job.droppedSamples = int(_job.droppedSamples) + 1
			return
		_raw_bytes -= old_bytes
		_raw_samples[slot] = sample
	else:
		if _raw_bytes + encoded_bytes > MAX_EVIDENCE_BYTES:
			_job.droppedSamples = int(_job.droppedSamples) + 1
			return
		_raw_samples.append(sample)
	_raw_bytes += encoded_bytes

func _finalize(state: String, complete: bool, reason: String) -> void:
	if _job.is_empty() or String(_job.get("state", "")) != "running":
		return
	_unregister_engine_profiler()
	_job.state = state
	_job.complete = complete
	_job.finishedMonotonicUsec = Time.get_ticks_usec()
	_job.endFrame = Engine.get_process_frames()
	_job.terminalReason = reason.left(256)
	var aggregates: Dictionary = {}
	var metric_names: Array = _series.keys()
	metric_names.sort()
	for name_value: Variant in metric_names:
		var name := String(name_value)
		aggregates[name] = _aggregate(_series[name])
	var evidence := {
		"schemaVersion": 1,
		"jobToken": String(_job.jobToken),
		"state": state,
		"complete": complete,
		"startedMonotonicUsec": int(_job.startedMonotonicUsec),
		"finishedMonotonicUsec": int(_job.finishedMonotonicUsec),
		"startFrame": int(_job.startFrame),
		"endFrame": int(_job.endFrame),
		"requestedDurationMs": int(_job.requestedDurationMs),
		"intervalFrames": int(_job.intervalFrames),
		"observedSamples": int(_job.observedSamples),
		"retainedSamples": _raw_samples.size() if bool(_job.retainRaw) else 0,
		"invalidSamples": int(_job.invalidSamples),
		"droppedSamples": int(_job.droppedSamples),
		"aggregates": aggregates,
		"rawSamples": _raw_samples.duplicate(true) if bool(_job.retainRaw) else [],
		"engine": _engine_metadata(),
		"gpuTimestamps": _gpu_timestamps(),
	}
	if not reason.is_empty():
		evidence.terminalReason = reason.left(256)
	evidence.sha256 = _evidence_digest(evidence)
	_job.evidence = evidence
	_rendering_device = null

func _status_receipt() -> Dictionary:
	var elapsed := 0
	if not _job.is_empty():
		var endpoint := Time.get_ticks_usec() if String(_job.state) == "running" else int(_job.finishedMonotonicUsec)
		elapsed = maxi(0, endpoint - int(_job.startedMonotonicUsec))
	var duration_usec := maxi(1, int(_job.get("requestedDurationMs", 1)) * 1000)
	var receipt := {
		"jobToken": String(_job.get("jobToken", "")),
		"state": String(_job.get("state", "failed")),
		"progress": clampf(float(elapsed) / float(duration_usec), 0.0, 1.0),
		"observedSamples": int(_job.get("observedSamples", 0)),
		"retainedSamples": _raw_samples.size() if bool(_job.get("retainRaw", false)) else 0,
	}
	if not String(_job.get("terminalReason", "")).is_empty():
		receipt.terminalReason = String(_job.terminalReason)
	return receipt

func _flatten_values(groups: Dictionary) -> Dictionary:
	var values: Dictionary = {}
	var group_names: Array = groups.keys()
	group_names.sort()
	for group_value: Variant in group_names:
		var group := String(group_value)
		var monitor_values: Dictionary = groups[group]
		var monitor_names: Array = monitor_values.keys()
		monitor_names.sort()
		for monitor_value: Variant in monitor_names:
			if values.size() >= MAX_METRICS:
				return values
			var monitor := String(monitor_value)
			values["%s.%s" % [group, monitor]] = float(monitor_values[monitor])
	return values

func _custom_monitors(unavailable: Array[String]) -> Dictionary:
	var values: Dictionary = {}
	var names: Array = Performance.get_custom_monitor_names()
	names.sort_custom(func(a: Variant, b: Variant) -> bool: return String(a) < String(b))
	for name_value: Variant in names.slice(0, 128):
		var name := String(name_value)
		if name.to_utf8_buffer().size() > 128:
			unavailable.append("Custom monitor name exceeds 128 bytes")
			continue
		var value: Variant = Performance.get_custom_monitor(name_value)
		if (typeof(value) != TYPE_INT and typeof(value) != TYPE_FLOAT) or not is_finite(float(value)):
			unavailable.append("Custom monitor %s is not finite numeric" % name.left(128))
			continue
		values[name] = float(value)
	return values

func _validate_groups(groups: Array, maximum: int) -> Dictionary:
	if groups.is_empty() or groups.size() > maximum:
		return _error("INVALID_REQUEST", "Monitor group count is invalid")
	var output: Array[String] = []
	for group_value: Variant in groups:
		if typeof(group_value) != TYPE_STRING or String(group_value) not in ALLOWED_GROUPS or String(group_value) in output:
			return _error("INVALID_REQUEST", "Monitor groups must be unique known names")
		output.append(String(group_value))
	return {"ok": true, "groups": output}

func _aggregate(raw_values: Array) -> Dictionary:
	if raw_values.is_empty():
		return {"min": 0.0, "max": 0.0, "mean": 0.0, "p50": 0.0, "p95": 0.0, "p99": 0.0}
	var values := raw_values.duplicate()
	values.sort()
	var total := 0.0
	for value: Variant in values:
		total += float(value)
	return {
		"min": float(values[0]),
		"max": float(values[-1]),
		"mean": total / float(values.size()),
		"p50": _percentile(values, 0.50),
		"p95": _percentile(values, 0.95),
		"p99": _percentile(values, 0.99),
	}

func _percentile(values: Array, percentile: float) -> float:
	return float(values[int(ceil(percentile * float(values.size() - 1)))])

func _register_engine_profiler() -> void:
	if not EngineDebugger.is_active() or EngineDebugger.has_profiler(PROFILER_NAME):
		return
	_engine_profiler = RuntimeEngineProfiler.new(self)
	EngineDebugger.register_profiler(PROFILER_NAME, _engine_profiler)
	EngineDebugger.profiler_enable(PROFILER_NAME, true)
	_profiler_registered = true

func _unregister_engine_profiler() -> void:
	if _profiler_registered and EngineDebugger.has_profiler(PROFILER_NAME):
		EngineDebugger.profiler_enable(PROFILER_NAME, false)
		EngineDebugger.unregister_profiler(PROFILER_NAME)
	_profiler_registered = false
	_engine_profiler = null

func _gpu_timestamps() -> Dictionary:
	var device := _rendering_device if _rendering_device != null else RenderingServer.get_rendering_device()
	if device == null:
		return {"supported": false, "reason": "RenderingDevice is unavailable"}
	var count := mini(device.get_captured_timestamps_count(), MAX_SAMPLES + 1)
	if count < 2:
		return {"supported": false, "reason": "Captured GPU timestamps are unavailable"}
	var start := maxi(0, device.get_captured_timestamps_count() - count)
	var deltas: Array[float] = []
	var previous := device.get_captured_timestamp_gpu_time(start)
	for index in range(start + 1, start + count):
		var current := device.get_captured_timestamp_gpu_time(index)
		if current >= previous:
			deltas.append(float(current - previous))
		previous = current
	return {"supported": true, "deltasUsec": deltas}

func _engine_metadata() -> Dictionary:
	var renderer := RenderingServer.get_video_adapter_name()
	var api := RenderingServer.get_video_adapter_api_version()
	var method := String(ProjectSettings.get_setting("rendering/renderer/rendering_method", "unknown"))
	return {
		"version": String(Engine.get_version_info().get("string", "unknown")),
		"renderer": renderer if not renderer.is_empty() else "headless",
		"renderingMethod": method if not method.is_empty() else "unknown",
		"graphicsApi": api if not api.is_empty() else "unavailable",
	}

func _token_matches(job_token: String) -> bool:
	return not _job.is_empty() and job_token == String(_job.get("jobToken", ""))

func _opaque_token() -> String:
	var encoded := Marshalls.raw_to_base64(Crypto.new().generate_random_bytes(32))
	return "pjt_" + encoded.replace("+", "-").replace("/", "_").replace("=", "")

func _evidence_digest(evidence: Dictionary) -> String:
	var digest_input := evidence.duplicate(true)
	digest_input.erase("sha256")
	var encoded := CanonicalJson.encode(_tag_floats(digest_input))
	return encoded.sha256_text()

func _tag_floats(value: Variant) -> Variant:
	if typeof(value) == TYPE_FLOAT:
		return {"type": "FloatJson", "value": JSON.stringify(value)}
	if typeof(value) == TYPE_ARRAY:
		var output: Array = []
		for item: Variant in value:
			output.append(_tag_floats(item))
		return output
	if typeof(value) == TYPE_DICTIONARY:
		var output := {}
		for key: Variant in value.keys():
			output[String(key)] = _tag_floats(value[key])
		return output
	return value

static func _error(code: String, message: String, retryable := false) -> Dictionary:
	return {"ok": false, "code": code, "message": message.left(512), "retryable": retryable}
