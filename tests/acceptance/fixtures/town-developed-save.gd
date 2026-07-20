extends SceneTree

const SaveRepositoryType := preload("res://src/persistence/save_repository.gd")
const WorldStateType := preload("res://src/domain/world_state.gd")
const DistrictGeneratorType := preload("res://src/systems/district_generator.gd")
const BuildingInstanceType := preload("res://src/domain/building_instance.gd")
const FIXED_UNIX_TIME := 4_102_444_800

func _init() -> void:
	var state = WorldStateType.new_game(4107)
	state.districts["starter"] = DistrictGeneratorType.generate_starter(state.seed)
	var district = state.districts["starter"]
	var definitions := [&"home", &"boba_cafe", &"fried_chicken", &"pocket_park"]
	for index in definitions.size():
		var id := "qa_%s" % definitions[index]
		var building = BuildingInstanceType.create(id, definitions[index], district.buildable_cells[index * 12])
		building.visits = 6 + index
		building.pending_income_visits = index
		district.buildings[id] = building
	state.population = 18
	state.vibe = 42
	state.last_saved_unix = FIXED_UNIX_TIME
	var repository = SaveRepositoryType.new("user://saves")
	repository.set_clock(func() -> int: return FIXED_UNIX_TIME)
	if not repository.save(state):
		push_error("GODOT_MCP_TOWN_SAVE_FAILED")
		quit(1)
		return
	print("GODOT_MCP_TOWN_SAVE_READY")
	quit()
