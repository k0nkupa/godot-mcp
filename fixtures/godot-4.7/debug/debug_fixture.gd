extends Node2D

const RemoteObject = preload("res://debug/debug_remote_object.gd")

static var global_counter := 0
@export var member_label := "phase-7-member"
@export var breakpoint_hits := 0
@export var workload_total := 0.0
var _remote_object := RemoteObject.new()

func _ready() -> void:
	Performance.add_custom_monitor("Phase7/BreakpointHits", func() -> int: return breakpoint_hits)
	Performance.add_custom_monitor("Phase7/WorkloadTotal", func() -> float: return workload_total)

func _exit_tree() -> void:
	if Performance.has_custom_monitor("Phase7/BreakpointHits"):
		Performance.remove_custom_monitor("Phase7/BreakpointHits")
	if Performance.has_custom_monitor("Phase7/WorkloadTotal"):
		Performance.remove_custom_monitor("Phase7/WorkloadTotal")

func _process(delta: float) -> void:
	global_counter += 1
	_outer(delta)

func _outer(delta: float) -> void:
	var outer_label := "outer"
	_middle(delta, outer_label)

func _middle(delta: float, outer_label: String) -> void:
	var middle_values := [outer_label, "middle", global_counter]
	_inner(delta, middle_values)

func _inner(delta: float, middle_values: Array) -> void:
	var player := {"health": 100, "name": "Phase7Player", "inventory": ["key", "map"]}
	var vector := Vector2(3.0, 4.0)
	var remote_object := _remote_object
	breakpoint_hits += 1 # PHASE7_BREAKPOINT_INNER
	var accumulator := workload_total
	for index in 2000:
		accumulator += sin(float(index) * 0.001 + delta)
	workload_total = accumulator + float(player.health) + vector.length() + float(middle_values.size()) + float(remote_object.health)

func deliberate_error() -> void:
	assert(false, "PHASE7_DELIBERATE_ERROR")
