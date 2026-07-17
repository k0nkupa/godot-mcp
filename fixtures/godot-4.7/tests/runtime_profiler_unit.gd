extends SceneTree

const RuntimeProfiler = preload("res://addons/godot_mcp/runtime/runtime_profiler.gd")

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

	var first := profiler.start({"durationMs": 100, "intervalFrames": 1, "groups": ["frame"], "retainRaw": true})
	assert(first.ok)
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
	assert(profiler._tag_floats(precise_float) == {"type": "Float64Le", "value": "5ff64637dd9abf3f"})
	assert(profiler._wire_size({"value": 0.25}) > JSON.stringify({"value": 0.25}).to_utf8_buffer().size())

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
	assert(profiler.snapshot(["rendering"]).data.gpuTimestamps.has("supported"))
	Performance.remove_custom_monitor("Phase7/Stable")
	profiler.clear()
	profiler.clear()
	print("PHASE7_PROFILER_UNIT_OK")
	quit(0)

func _custom_monitor_value() -> float:
	return 12.5
