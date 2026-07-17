class_name GodotMcpRuntimeProfiler
extends RefCounted

const CanonicalJson = preload("res://addons/godot_mcp/bridge/canonical_json.gd")
const SessionCrypto = preload("res://addons/godot_mcp/bridge/session_crypto.gd")
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
var _gpu_deltas: Array[float] = []
var _gpu_seen_samples: Dictionary = {}
var _gpu_job_id := 0

func snapshot(groups: Array) -> Dictionary:
	var valid := _validate_groups(groups, 9)
	if not valid.ok:
		return valid
	var sampled := _sample_groups(valid.groups)
	return {"ok": true, "data": {
		"schemaVersion": 1,
		"frame": Engine.get_process_frames(),
		"monotonicUsec": Time.get_ticks_usec(),
		"engine": _engine_metadata(),
		"groups": sampled.groups,
		"unavailable": sampled.unavailable,
		"gpuTimestamps": _gpu_timestamps(),
	}}

func _sample_groups(groups: Array) -> Dictionary:
	var unavailable: Array[String] = []
	var output_groups: Dictionary = {}
	var omitted_metric_count := 0
	var omitted_groups: Dictionary = {}
	for group: String in groups:
		if group == "custom":
			var custom := _custom_monitors(unavailable)
			output_groups[group] = custom.values
			omitted_metric_count += int(custom.omittedMetricCount)
			if int(custom.omittedMetricCount) > 0:
				omitted_groups[group] = true
		else:
			var values: Dictionary = {}
			for monitor: Array in GROUP_MONITORS.get(group, []):
				var value := float(Performance.get_monitor(int(monitor[1])))
				if is_finite(value):
					values[String(monitor[0])] = value
				else:
					unavailable.append("%s.%s is not finite" % [group, String(monitor[0])])
			output_groups[group] = values
	return {
		"groups": output_groups,
		"unavailable": unavailable.slice(0, 128),
		"omittedMetricCount": omitted_metric_count,
		"omittedGroups": _sorted_string_keys(omitted_groups),
	}

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
	_gpu_deltas.clear()
	_gpu_seen_samples.clear()
	_gpu_job_id += 1
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
		"metricTruncationAffectedSamples": 0,
		"metricTruncationMaxDropped": 0,
		"metricTruncationGroups": {},
		"terminalReason": "",
	}
	_register_engine_profiler()
	_rendering_device = RenderingServer.get_rendering_device()
	_sample_frame(true)
	return {"ok": true, "data": _status_receipt()}

func process_frame() -> void:
	if _job.is_empty() or String(_job.get("state", "")) != "running":
		return
	_advance_deadline()
	if String(_job.get("state", "")) != "running":
		return
	_sample_frame(false)

func _sample_frame(force: bool) -> void:
	var frame := Engine.get_process_frames()
	if not force and (frame - int(_job.startFrame)) % int(_job.intervalFrames) != 0:
		return
	var sample_id := int(_job.observedSamples) + 1
	_capture_profile_gpu_marker("start", sample_id)
	var sampled := _sample_groups(_job.groups)
	var flattened := _flatten_values(sampled.groups, _tick_values)
	if int(sampled.omittedMetricCount) > 0:
		flattened.truncated = true
		flattened.droppedMetricCount = int(flattened.droppedMetricCount) + int(sampled.omittedMetricCount)
		var dropped_groups: Dictionary = {}
		for group: String in flattened.droppedGroups:
			dropped_groups[group] = true
		for group: String in sampled.omittedGroups:
			dropped_groups[group] = true
		flattened.droppedGroups = _sorted_string_keys(dropped_groups)
	var values: Dictionary = flattened.values
	if bool(flattened.truncated):
		_job.metricTruncationAffectedSamples = int(_job.metricTruncationAffectedSamples) + 1
		_job.metricTruncationMaxDropped = maxi(int(_job.metricTruncationMaxDropped), int(flattened.droppedMetricCount))
		for group: String in flattened.droppedGroups:
			_job.metricTruncationGroups[group] = true
	_job.observedSamples = int(_job.observedSamples) + 1
	if values.is_empty():
		_job.invalidSamples = int(_job.invalidSamples) + 1
		if bool(_job.retainRaw):
			_job.droppedSamples = int(_job.droppedSamples) + 1
		_capture_profile_gpu_marker("end", sample_id)
		return
	_record_aggregates(values, int(_job.observedSamples))
	if bool(_job.retainRaw):
		_retain_raw({"frame": frame, "monotonicUsec": Time.get_ticks_usec(), "values": values}, int(_job.observedSamples))
	_capture_profile_gpu_marker("end", sample_id)

func _advance_deadline() -> void:
	if _job.is_empty() or String(_job.get("state", "")) != "running":
		return
	_collect_profile_gpu_deltas()
	if Time.get_ticks_usec() - int(_job.startedMonotonicUsec) >= int(_job.requestedDurationMs) * 1000:
		_finalize("completed", true, "")

func status(job_token: String) -> Dictionary:
	if not _token_matches(job_token):
		return _error("STALE_HANDLE", "Profile job token is stale or unknown")
	_advance_deadline()
	return {"ok": true, "data": _status_receipt()}

func cancel(job_token: String) -> Dictionary:
	if not _token_matches(job_token):
		return _error("STALE_HANDLE", "Profile job token is stale or unknown")
	_advance_deadline()
	if String(_job.state) == "running":
		_finalize("cancelled", false, "Profile cancelled by request")
	return {"ok": true, "data": _status_receipt()}

func result(job_token: String) -> Dictionary:
	if not _token_matches(job_token):
		return _error("STALE_HANDLE", "Profile job token is stale or unknown")
	_advance_deadline()
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
	_gpu_deltas.clear()
	_gpu_seen_samples.clear()
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
	var encoded_bytes := _wire_size(sample)
	if encoded_bytes > MAX_EVIDENCE_BYTES:
		_job.droppedSamples = int(_job.droppedSamples) + 1
		return
	var slot := retention_slot(observed_count, MAX_SAMPLES)
	if slot < 0:
		_job.droppedSamples = int(_job.droppedSamples) + 1
		return
	if slot < _raw_samples.size():
		var old_bytes := _wire_size(_raw_samples[slot])
		if _raw_bytes - old_bytes + encoded_bytes > MAX_EVIDENCE_BYTES:
			_job.droppedSamples = int(_job.droppedSamples) + 1
			return
		_raw_bytes -= old_bytes
		_raw_samples[slot] = sample
		_job.droppedSamples = int(_job.droppedSamples) + 1
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
		"metricTruncation": {
			"truncated": int(_job.metricTruncationAffectedSamples) > 0,
			"affectedSamples": int(_job.metricTruncationAffectedSamples),
			"maxDroppedMetricsPerSample": int(_job.metricTruncationMaxDropped),
			"droppedGroups": _sorted_string_keys(_job.metricTruncationGroups),
		},
		"aggregates": aggregates,
		"rawSamples": _raw_samples.duplicate(true) if bool(_job.retainRaw) else [],
		"engine": _engine_metadata(),
		"gpuTimestamps": _profile_gpu_timestamps(),
	}
	if not reason.is_empty():
		evidence.terminalReason = reason.left(256)
	evidence.sha256 = "0".repeat(64)
	while _wire_size(evidence) > MAX_EVIDENCE_BYTES and not evidence.rawSamples.is_empty():
		evidence.rawSamples.pop_back()
		evidence.retainedSamples = evidence.rawSamples.size()
		evidence.droppedSamples = int(evidence.droppedSamples) + 1
	_raw_samples.assign(evidence.rawSamples)
	_raw_bytes = 0
	for sample: Dictionary in _raw_samples:
		_raw_bytes += _wire_size(sample)
	evidence.erase("sha256")
	evidence.sha256 = _evidence_digest(evidence)
	assert(_wire_size(evidence) <= MAX_EVIDENCE_BYTES)
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

func _flatten_values(groups: Dictionary, tick_values: Dictionary = {}) -> Dictionary:
	var values: Dictionary = {}
	var group_names: Array = groups.keys()
	group_names.sort()
	group_names.erase("custom")
	var dropped_metric_count := 0
	var dropped_groups: Dictionary = {}
	for group_value: Variant in group_names:
		var group := String(group_value)
		var monitor_values: Dictionary = groups[group]
		var monitor_names: Array = monitor_values.keys()
		monitor_names.sort()
		for monitor_value: Variant in monitor_names:
			if values.size() >= MAX_METRICS:
				dropped_metric_count += 1
				dropped_groups[group] = true
				continue
			var monitor := String(monitor_value)
			values["%s.%s" % [group, monitor]] = float(monitor_values[monitor])
	var tick_names: Array = tick_values.keys()
	tick_names.sort()
	for tick_value: Variant in tick_names:
		var tick_name := String(tick_value)
		if values.size() >= MAX_METRICS:
			dropped_metric_count += 1
			dropped_groups["profiler"] = true
			continue
		values[tick_name] = float(tick_values[tick_name])
	# Custom monitors are lowest priority after requested built-in groups and
	# EngineProfiler tick metrics reserve their capacity.
	if groups.has("custom"):
		var custom_values: Dictionary = groups.custom
		var custom_names: Array = custom_values.keys()
		custom_names.sort()
		for custom_value: Variant in custom_names:
			if values.size() >= MAX_METRICS:
				dropped_metric_count += 1
				dropped_groups["custom"] = true
				continue
			var custom_name := String(custom_value)
			values["custom.%s" % custom_name] = float(custom_values[custom_name])
	return {
		"values": values,
		"truncated": dropped_metric_count > 0,
		"droppedMetricCount": dropped_metric_count,
		"droppedGroups": _sorted_string_keys(dropped_groups),
	}

func _sorted_string_keys(source: Dictionary) -> Array[String]:
	var output: Array[String] = []
	for key: Variant in source.keys():
		output.append(String(key))
	output.sort()
	return output

func _custom_monitors(unavailable: Array[String]) -> Dictionary:
	var values: Dictionary = {}
	var names: Array = Performance.get_custom_monitor_names()
	names.sort_custom(func(a: Variant, b: Variant) -> bool: return String(a) < String(b))
	var omitted_metric_count := maxi(0, names.size() - 128)
	if omitted_metric_count > 0:
		unavailable.append("Custom monitor list omitted %d names beyond the 128-name limit" % omitted_metric_count)
	for name_value: Variant in names.slice(0, 128):
		var name := String(name_value)
		if name == SessionCrypto.FLOAT_WIRE_KEY:
			unavailable.append("Custom monitor name is reserved by the bridge float wire contract")
			continue
		if name.to_utf8_buffer().size() > 128:
			unavailable.append("Custom monitor name exceeds 128 bytes")
			continue
		var value: Variant = Performance.get_custom_monitor(name_value)
		if (typeof(value) != TYPE_INT and typeof(value) != TYPE_FLOAT) or not is_finite(float(value)):
			unavailable.append("Custom monitor %s is not finite numeric" % name.left(128))
			continue
		values[name] = float(value)
	return {"values": values, "omittedMetricCount": omitted_metric_count}

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
	var scale := maxf(absf(float(values[0])), absf(float(values[-1])))
	var normalized_total := 0.0
	if scale > 0.0:
		for value: Variant in values:
			normalized_total += float(value) / scale
	var mean := clampf(normalized_total / float(values.size()), -1.0, 1.0) * scale
	return {
		"min": float(values[0]),
		"max": float(values[-1]),
		"mean": mean,
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
	var total := device.get_captured_timestamps_count()
	var start := maxi(0, total - (MAX_SAMPLES + 1))
	var count := mini(total - start, MAX_SAMPLES + 1)
	if count < 2:
		return {"supported": false, "reason": "Captured GPU timestamps are unavailable"}
	var deltas: Array[float] = []
	var previous := device.get_captured_timestamp_gpu_time(start)
	for index in range(start + 1, start + count):
		var current := device.get_captured_timestamp_gpu_time(index)
		if current >= previous:
			deltas.append(gpu_microseconds_delta(current - previous))
		previous = current
	return {"supported": true, "deltasUsec": deltas}

func _capture_profile_gpu_marker(kind: String, sample_id: int) -> void:
	if _rendering_device != null:
		_rendering_device.capture_timestamp("godot_mcp_profile_%d_%s_%d" % [_gpu_job_id, kind, sample_id])

func _collect_profile_gpu_deltas() -> void:
	if _rendering_device == null or _gpu_deltas.size() >= MAX_SAMPLES:
		return
	var total := _rendering_device.get_captured_timestamps_count()
	var start := maxi(0, total - 4096)
	var names: Array[String] = []
	var times: Array[int] = []
	for index in range(start, total):
		names.append(_rendering_device.get_captured_timestamp_name(index))
		times.append(_rendering_device.get_captured_timestamp_gpu_time(index))
	for pair: Dictionary in extract_profile_gpu_pairs(names, times, _gpu_job_id):
		var sample_id := int(pair.sampleId)
		if not _gpu_seen_samples.has(sample_id) and _gpu_deltas.size() < MAX_SAMPLES:
			_gpu_seen_samples[sample_id] = true
			_gpu_deltas.append(float(pair.deltaUsec))

func _profile_gpu_timestamps() -> Dictionary:
	_collect_profile_gpu_deltas()
	if _gpu_deltas.is_empty():
		return {"supported": false, "reason": "Paired per-frame GPU timestamps are unavailable"}
	return {"supported": true, "deltasUsec": _gpu_deltas.duplicate()}

static func extract_profile_gpu_pairs(names: Array, times: Array, job_id: int) -> Array[Dictionary]:
	var starts := {}
	var pairs: Array[Dictionary] = []
	var count := mini(names.size(), times.size())
	var start_prefix := "godot_mcp_profile_%d_start_" % job_id
	var end_prefix := "godot_mcp_profile_%d_end_" % job_id
	for index in count:
		var name := String(names[index])
		if name.begins_with(start_prefix):
			starts[int(name.trim_prefix(start_prefix))] = int(times[index])
		elif name.begins_with(end_prefix):
			var sample_id := int(name.trim_prefix(end_prefix))
			if starts.has(sample_id) and int(times[index]) >= int(starts[sample_id]):
				pairs.append({"sampleId": sample_id, "deltaUsec": gpu_microseconds_delta(int(times[index]) - int(starts[sample_id]))})
	return pairs

static func extract_profile_gpu_deltas(names: Array, times: Array, job_id: int) -> Array[float]:
	var deltas: Array[float] = []
	for pair: Dictionary in extract_profile_gpu_pairs(names, times, job_id):
		deltas.append(float(pair.deltaUsec))
	return deltas

static func gpu_microseconds_delta(microseconds: int) -> float:
	return float(maxi(0, microseconds))

func _wire_size(value: Variant) -> int:
	return CanonicalJson.encode(SessionCrypto._canonical_signing_params(value)).to_utf8_buffer().size()

func _engine_metadata() -> Dictionary:
	var renderer := RenderingServer.get_video_adapter_name()
	var api := RenderingServer.get_video_adapter_api_version()
	var method := String(ProjectSettings.get_setting("rendering/renderer/rendering_method", "unknown"))
	return {
		"version": bound_metadata_value(String(Engine.get_version_info().get("string", "unknown")), "unknown"),
		"renderer": bound_metadata_value(renderer, "headless"),
		"renderingMethod": bound_metadata_value(method, "unknown"),
		"graphicsApi": bound_metadata_value(api, "unavailable"),
	}

static func bound_metadata_value(value: String, fallback: String) -> String:
	var normalized := value if not value.is_empty() else fallback
	return normalized.left(128)

func _token_matches(job_token: String) -> bool:
	return not _job.is_empty() and job_token == String(_job.get("jobToken", ""))

func _opaque_token() -> String:
	var encoded := Marshalls.raw_to_base64(Crypto.new().generate_random_bytes(32))
	return "pjt_" + encoded.replace("+", "-").replace("/", "_").replace("=", "")

func _evidence_digest(evidence: Dictionary) -> String:
	var digest_input := evidence.duplicate(true)
	digest_input.erase("sha256")
	var encoded := CanonicalJson.encode(SessionCrypto._canonical_signing_params(digest_input))
	return encoded.sha256_text()

static func _error(code: String, message: String, retryable := false) -> Dictionary:
	return {"ok": false, "code": code, "message": message.left(512), "retryable": retryable}
