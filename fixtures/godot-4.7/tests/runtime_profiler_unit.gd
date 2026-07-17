extends SceneTree

const RuntimeProfiler = preload("res://addons/godot_mcp/runtime/runtime_profiler.gd")
const CanonicalJson = preload("res://addons/godot_mcp/bridge/canonical_json.gd")
const SessionCrypto = preload("res://addons/godot_mcp/bridge/session_crypto.gd")

func _init() -> void:
	var profiler := RuntimeProfiler.new()
	Performance.add_custom_monitor("Phase7/Stable", _custom_monitor_value)
	var snapshot: Dictionary = profiler.snapshot(["frame", "memory"])
	assert(snapshot.ok)
	assert(snapshot.data.schemaVersion == 1)
	assert(snapshot.data.groups.has("frame"))
	assert(snapshot.data.groups.has("memory"))
	assert(not snapshot.data.groups.has("objects"))
	assert(snapshot.data.engine.version.length() > 0)
	for group: Dictionary in snapshot.data.groups.values():
		for value: Variant in group.values():
			assert(typeof(value) == TYPE_FLOAT or typeof(value) == TYPE_INT)
			assert(is_finite(float(value)))
	var custom: Dictionary = profiler.snapshot(["custom"])
	assert(custom.ok and custom.data.groups.custom["Phase7/Stable"] == 12.5)
	assert(not profiler.snapshot(["unknown"]).ok)
	var sampled_groups: Dictionary = profiler._sample_groups(["frame"])
	assert(sampled_groups.has("groups") and sampled_groups.has("unavailable"))
	assert(not sampled_groups.has("gpuTimestamps"))
	Performance.remove_custom_monitor("Phase7/Stable")
	var invalid_retained := profiler.start({"durationMs": 30000, "intervalFrames": 1, "groups": ["custom"], "retainRaw": true})
	assert(invalid_retained.ok)
	assert(invalid_retained.data.observedSamples == 1)
	assert(profiler.cancel(String(invalid_retained.data.jobToken)).ok)
	var invalid_evidence: Dictionary = profiler.result(String(invalid_retained.data.jobToken)).data.evidence
	assert(invalid_evidence.invalidSamples == 1)
	assert(invalid_evidence.droppedSamples == 1)
	assert(invalid_evidence.rawSamples.is_empty())
	Performance.add_custom_monitor("Phase7/Stable", _custom_monitor_value)
	assert(RuntimeProfiler.bound_metadata_value("x".repeat(129), "fallback").length() == 128)
	assert(RuntimeProfiler.bound_metadata_value("", "fallback") == "fallback")

	var first := profiler.start({"durationMs": 100, "intervalFrames": 1, "groups": ["frame"], "retainRaw": true})
	assert(first.ok)
	assert(first.data.observedSamples > 0)
	assert(String(first.data.jobToken).begins_with("pjt_") and String(first.data.jobToken).length() == 47)
	assert(not profiler.start({"durationMs": 100, "intervalFrames": 1, "groups": ["frame"], "retainRaw": true}).ok)
	var deadline := Time.get_ticks_msec() + 2000
	while profiler.status(String(first.data.jobToken)).data.state == "running" and Time.get_ticks_msec() < deadline:
		profiler.process_frame()
		await process_frame
	var completed := profiler.result(String(first.data.jobToken))
	assert(completed.ok)
	assert(completed.data.evidence.state == "completed")
	assert(completed.data.evidence.complete)
	assert(completed.data.evidence.observedSamples > 0)
	assert(completed.data.evidence.retainedSamples == completed.data.evidence.rawSamples.size())
	assert(profiler._wire_size(completed.data.evidence) <= RuntimeProfiler.MAX_EVIDENCE_BYTES)
	assert(String(completed.data.evidence.sha256).length() == 64)
	assert(profiler.result(String(first.data.jobToken)).data.evidence.sha256 == completed.data.evidence.sha256)
	var precise_float: float = JSON.parse_string("0.12345678901234567")
	assert(profiler._evidence_digest({"value": precise_float}) == CanonicalJson.encode(SessionCrypto._canonical_signing_params({"value": precise_float})).sha256_text())
	assert(profiler._wire_size({"value": 0.25}) > JSON.stringify({"value": 0.25}).to_utf8_buffer().size())
	var extreme := profiler._aggregate([1.0e308, 1.0e308])
	assert(is_finite(float(extreme.mean)) and float(extreme.mean) > 9.0e307)

	var deadline_only := profiler.start({"durationMs": 100, "intervalFrames": 120, "groups": ["frame"], "retainRaw": false})
	assert(deadline_only.ok and deadline_only.data.observedSamples > 0)
	await create_timer(0.12).timeout
	var deadline_status := profiler.status(String(deadline_only.data.jobToken))
	assert(deadline_status.ok and deadline_status.data.state == "completed")
	assert(profiler.result(String(deadline_only.data.jobToken)).ok)

	var cancellation := profiler.start({"durationMs": 30000, "intervalFrames": 1, "groups": ["frame"], "retainRaw": false})
	assert(cancellation.ok)
	profiler.process_frame()
	var cancelled := profiler.cancel(String(cancellation.data.jobToken))
	assert(cancelled.ok and cancelled.data.state == "cancelled")
	var partial := profiler.result(String(cancellation.data.jobToken))
	assert(partial.ok and not partial.data.evidence.complete)
	assert(partial.data.evidence.state == "cancelled")
	assert(partial.data.evidence.rawSamples.is_empty())
	assert(not profiler.result("pjt_" + "z".repeat(43)).ok)

	var slots_a: Array[int] = []
	var slots_b: Array[int] = []
	for observed in 4096:
		slots_a.append(RuntimeProfiler.retention_slot(observed + 1, 2048))
		slots_b.append(RuntimeProfiler.retention_slot(observed + 1, 2048))
	assert(slots_a == slots_b)
	assert(slots_a.max() < 2048)
	profiler._job = {"droppedSamples": 0}
	profiler._raw_samples.clear()
	profiler._raw_bytes = 0
	var retained_sample := {"frame": 1, "monotonicUsec": 1, "values": {"frame.fps": 60.0}}
	for index in RuntimeProfiler.MAX_SAMPLES:
		var sample: Dictionary = retained_sample.duplicate(true)
		sample.frame = index
		profiler._raw_samples.append(sample)
		profiler._raw_bytes += profiler._wire_size(sample)
	var replacement_observed := RuntimeProfiler.MAX_SAMPLES + 1
	while RuntimeProfiler.retention_slot(replacement_observed, RuntimeProfiler.MAX_SAMPLES) < 0:
		replacement_observed += 1
	profiler._retain_raw({"frame": replacement_observed, "monotonicUsec": 2, "values": {"frame.fps": 59.0}}, replacement_observed)
	assert(profiler._raw_samples.size() == RuntimeProfiler.MAX_SAMPLES)
	assert(profiler._job.droppedSamples == 1)
	var gpu_timestamps: Dictionary = profiler.snapshot(["rendering"]).data.gpuTimestamps
	assert(not gpu_timestamps.supported)
	assert(String(gpu_timestamps.reason).contains("render-frame bracketing"))
	Performance.add_custom_monitor("$godotMcpFloat64Le", _custom_monitor_value)
	var reserved_custom: Dictionary = profiler.snapshot(["custom"])
	assert(reserved_custom.ok)
	assert(not reserved_custom.data.groups.custom.has("$godotMcpFloat64Le"))
	assert(reserved_custom.data.unavailable.any(func(message: String) -> bool: return message.contains("reserved")))
	for index in 128:
		Performance.add_custom_monitor("Overflow%03d" % index, _custom_monitor_value)
	var omitted_custom: Dictionary = profiler._sample_groups(["custom"])
	assert(omitted_custom.omittedMetricCount == 2)
	assert(omitted_custom.omittedGroups == ["custom"])
	assert(omitted_custom.unavailable.any(func(message: String) -> bool: return message.contains("omitted 2")))
	for index in 128:
		Performance.remove_custom_monitor("Overflow%03d" % index)
	var crowded_custom: Dictionary = {}
	for index in RuntimeProfiler.MAX_METRICS:
		crowded_custom["Monitor%03d" % index] = float(index)
	var bounded := profiler._flatten_values(
		{"custom": crowded_custom, "frame": {"fps": 60.0}},
		{"profiler.frame_seconds": 0.016},
	)
	assert(bounded.values.size() == RuntimeProfiler.MAX_METRICS)
	assert(bounded.values.has("frame.fps"))
	assert(bounded.values.has("profiler.frame_seconds"))
	assert(bounded.truncated)
	assert(bounded.droppedGroups == ["custom"])
	assert(bounded.droppedMetricCount == 2)
	for monitor_name: String in crowded_custom.keys():
		Performance.add_custom_monitor(monitor_name, _custom_monitor_value)
	var crowded_profile := profiler.start({"durationMs": 100, "intervalFrames": 1, "groups": ["frame", "custom"], "retainRaw": false})
	assert(crowded_profile.ok)
	var crowded_deadline := Time.get_ticks_msec() + 2000
	while profiler.status(String(crowded_profile.data.jobToken)).data.state == "running" and Time.get_ticks_msec() < crowded_deadline:
		profiler.process_frame()
		await process_frame
	var crowded_evidence: Dictionary = profiler.result(String(crowded_profile.data.jobToken)).data.evidence
	assert(crowded_evidence.complete)
	assert(crowded_evidence.metricTruncation.truncated)
	assert(crowded_evidence.metricTruncation.affectedSamples > 0)
	assert(crowded_evidence.metricTruncation.maxDroppedMetricsPerSample > 0)
	assert(crowded_evidence.metricTruncation.droppedGroups == ["custom"])
	assert(crowded_evidence.aggregates.has("frame.fps"))
	for monitor_name: String in crowded_custom.keys():
		Performance.remove_custom_monitor(monitor_name)
	Performance.remove_custom_monitor("$godotMcpFloat64Le")
	Performance.remove_custom_monitor("Phase7/Stable")
	profiler.clear()
	profiler.clear()
	print("PHASE7_PROFILER_UNIT_OK")
	quit(0)

func _custom_monitor_value() -> float:
	return 12.5
