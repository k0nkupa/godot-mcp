@tool
class_name GodotMcpThemeAuthoring
extends RefCounted

const ResourceLocator = preload("res://addons/godot_mcp/authoring/resource_locator.gd")
const VariantDecoder = preload("res://addons/godot_mcp/mutation/editor_variant_decoder.gd")

static func prepare(step_value: Dictionary, context: Dictionary) -> Dictionary:
	var step := step_value.duplicate(true)
	if String(step.operation) == "configure_control_layout": return _prepare_layout(step, context)
	return _prepare_theme(step, context)

static func apply_step(step: Dictionary, forward: bool) -> void:
	if String(step.operation) == "configure_control_layout":
		var control: Control = step._control
		var values: Dictionary = step._after if forward else step._before
		for property in values: control.set(property, values[property])
		return
	var theme: Theme = step._theme
	var had_before := bool(step._had_before)
	var should_set := (String(step.operation) == "set_theme_item") if forward else had_before
	var value: Variant = step._after if forward else step._before
	if should_set: _set_item(theme, String(step.itemKind), String(step.itemName), String(step.themeType), value)
	else: _clear_item(theme, String(step.itemKind), String(step.itemName), String(step.themeType))

static func _prepare_layout(step: Dictionary, context: Dictionary) -> Dictionary:
	var root: Node = context.get("root")
	if root == null: return _error("TARGET_NOT_FOUND", "Open scene root is unavailable")
	var node := root.get_node_or_null(NodePath(String(step.get("nodePath", ""))))
	if not node is Control: return _error("TARGET_NOT_FOUND", "Control target was not found")
	var before := {}; var after := {}
	var anchors: Dictionary = step.get("anchors", {})
	for side in ["left", "top", "right", "bottom"]:
		if anchors.has(side):
			var property := "anchor_%s" % side; before[property] = node.get(property); after[property] = float(anchors[side])
	var offsets: Dictionary = step.get("offsets", {})
	for side in ["left", "top", "right", "bottom"]:
		if offsets.has(side):
			var property := "offset_%s" % side; before[property] = node.get(property); after[property] = float(offsets[side])
	if step.has("minimumSize"):
		before.custom_minimum_size = node.custom_minimum_size; after.custom_minimum_size = Vector2(step.minimumSize.x, step.minimumSize.y)
	if step.has("horizontalSizeFlags"):
		before.size_flags_horizontal = node.size_flags_horizontal; after.size_flags_horizontal = int(step.horizontalSizeFlags)
	if step.has("verticalSizeFlags"):
		before.size_flags_vertical = node.size_flags_vertical; after.size_flags_vertical = int(step.verticalSizeFlags)
	step._control = node; step._before = before; step._after = after
	return {"ok": true, "step": step}

static func _prepare_theme(step: Dictionary, context: Dictionary) -> Dictionary:
	var operation := String(step.get("operation", ""))
	if operation not in ["set_theme_item", "remove_theme_item"]: return _error("INVALID_REQUEST", "Unsupported theme operation")
	var located := ResourceLocator.resolve(step.get("target", {}), context.get("filesystem"), context.get("rootResource"))
	if not located.ok: return located
	if not located.resource is Theme: return _error("INVALID_REQUEST", "Theme operation requires a Theme resource")
	var theme: Theme = located.resource
	var kind := String(step.itemKind); var item := String(step.itemName); var theme_type := String(step.themeType)
	var had_before := _has_item(theme, kind, item, theme_type)
	step._theme = theme; step._had_before = had_before; step._before = _get_item(theme, kind, item, theme_type) if had_before else null
	if operation == "set_theme_item":
		var decoded := VariantDecoder.decode(step.get("value"), context.get("filesystem"))
		if not decoded.ok: return decoded
		if not _valid_item_value(kind, decoded.value): return _error("INVALID_REQUEST", "Theme item value type does not match")
		step._after = decoded.value
	return {"ok": true, "step": step, "identity": located.identity}

static func _has_item(theme: Theme, kind: String, item: String, theme_type: String) -> bool:
	match kind:
		"color": return theme.has_color(item, theme_type)
		"constant": return theme.has_constant(item, theme_type)
		"font": return theme.has_font(item, theme_type)
		"font_size": return theme.has_font_size(item, theme_type)
		"icon": return theme.has_icon(item, theme_type)
		"stylebox": return theme.has_stylebox(item, theme_type)
	return false

static func _get_item(theme: Theme, kind: String, item: String, theme_type: String) -> Variant:
	match kind:
		"color": return theme.get_color(item, theme_type)
		"constant": return theme.get_constant(item, theme_type)
		"font": return theme.get_font(item, theme_type)
		"font_size": return theme.get_font_size(item, theme_type)
		"icon": return theme.get_icon(item, theme_type)
		"stylebox": return theme.get_stylebox(item, theme_type)
	return null

static func _set_item(theme: Theme, kind: String, item: String, theme_type: String, value: Variant) -> void:
	match kind:
		"color": theme.set_color(item, theme_type, value)
		"constant": theme.set_constant(item, theme_type, value)
		"font": theme.set_font(item, theme_type, value)
		"font_size": theme.set_font_size(item, theme_type, value)
		"icon": theme.set_icon(item, theme_type, value)
		"stylebox": theme.set_stylebox(item, theme_type, value)

static func _clear_item(theme: Theme, kind: String, item: String, theme_type: String) -> void:
	match kind:
		"color": theme.clear_color(item, theme_type)
		"constant": theme.clear_constant(item, theme_type)
		"font": theme.clear_font(item, theme_type)
		"font_size": theme.clear_font_size(item, theme_type)
		"icon": theme.clear_icon(item, theme_type)
		"stylebox": theme.clear_stylebox(item, theme_type)

static func _valid_item_value(kind: String, value: Variant) -> bool:
	match kind:
		"color": return value is Color
		"constant", "font_size": return typeof(value) == TYPE_INT
		"font": return value is Font
		"icon": return value is Texture2D
		"stylebox": return value is StyleBox
	return false

static func _error(code: String, message: String) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "retryable": false}
