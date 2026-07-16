import { z } from "zod";

const MAX_SOURCE_BYTES = 192 * 1024;
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const IdentifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const PropertyNameSchema = z.string().min(1).max(256).refine((value) => !value.includes(":" ) && !value.includes("\0"));
const MetadataKeySchema = z.string().min(1).max(128).refine((value) => !value.includes("\0"));

function isCanonicalResPath(value: string): boolean {
  if (!value.startsWith("res://") || value.includes("\0") || value.endsWith("/")) return false;
  const components = value.slice("res://".length).split("/");
  return components.length > 0 && components.every((component) => component.length > 0 && component !== "." && component !== "..");
}

function isProtectedPath(value: string): boolean {
  const components = value.slice("res://".length).split("/");
  const first = components[0]?.toLowerCase();
  return first === "addons" || first === ".godot" || first === ".git" || components.some((component) => component.startsWith("."));
}

const ResPathSchema = z.string().min(7).max(512).refine(isCanonicalResPath, { message: "Path must be canonical and project-local" });
const ScenePathSchema = ResPathSchema.refine((value) => value.endsWith(".tscn") || value.endsWith(".scn"), { message: "Scene path must name a Godot scene" });
const ResourcePathSchema = ResPathSchema.refine((value) => !value.endsWith(".gd") && !value.endsWith(".gdshader"), { message: "Resource path must not name source code" });
const SourcePathSchema = ResPathSchema.refine((value) => !isProtectedPath(value), { message: "Source path is protected" });
const NodePathSchema = z.string().min(1).max(512).refine(
  (value) => !value.startsWith("/") && !value.includes(":") && !value.includes("\0") && !value.split("/").includes(".."),
  { message: "Node path must be a relative descendant without subnames" },
);

const FiniteSchema = z.number().finite();
const Vector2Schema = z.object({ x: FiniteSchema, y: FiniteSchema }).strict();
const Vector3Schema = z.object({ x: FiniteSchema, y: FiniteSchema, z: FiniteSchema }).strict();
const Vector4Schema = z.object({ x: FiniteSchema, y: FiniteSchema, z: FiniteSchema, w: FiniteSchema }).strict();
const RectSchema = z.object({ left: FiniteSchema, top: FiniteSchema, right: FiniteSchema, bottom: FiniteSchema }).strict();
const ScalarImportValueSchema = z.union([z.boolean(), z.number().finite(), z.string().max(1_024)]);

export const ResourceLocatorSchema = z.object({
  resourcePath: ResourcePathSchema,
  propertyPath: z.array(IdentifierSchema).max(8).default([]),
}).strict();

export const ImportExpectationSchema = z.object({
  importer: IdentifierSchema,
  options: z.record(z.string().min(1).max(256), ScalarImportValueSchema)
    .refine((value) => Object.keys(value).length <= 64, { message: "Import expectation exceeds 64 options" }),
}).strict();

const NumericTagSchemas = [
  z.object({ type: z.literal("vector2"), x: FiniteSchema, y: FiniteSchema }).strict(),
  z.object({ type: z.literal("vector2i"), x: z.number().int(), y: z.number().int() }).strict(),
  z.object({ type: z.literal("vector3"), x: FiniteSchema, y: FiniteSchema, z: FiniteSchema }).strict(),
  z.object({ type: z.literal("vector3i"), x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict(),
  z.object({ type: z.literal("vector4"), x: FiniteSchema, y: FiniteSchema, z: FiniteSchema, w: FiniteSchema }).strict(),
  z.object({ type: z.literal("vector4i"), x: z.number().int(), y: z.number().int(), z: z.number().int(), w: z.number().int() }).strict(),
  z.object({ type: z.literal("rect2"), x: FiniteSchema, y: FiniteSchema, width: FiniteSchema, height: FiniteSchema }).strict(),
  z.object({ type: z.literal("rect2i"), x: z.number().int(), y: z.number().int(), width: z.number().int(), height: z.number().int() }).strict(),
  z.object({ type: z.literal("color"), r: FiniteSchema, g: FiniteSchema, b: FiniteSchema, a: FiniteSchema }).strict(),
  z.object({ type: z.literal("quaternion"), x: FiniteSchema, y: FiniteSchema, z: FiniteSchema, w: FiniteSchema }).strict(),
  z.object({ type: z.literal("plane"), x: FiniteSchema, y: FiniteSchema, z: FiniteSchema, d: FiniteSchema }).strict(),
  z.object({ type: z.literal("aabb"), position: z.tuple([FiniteSchema, FiniteSchema, FiniteSchema]), size: z.tuple([FiniteSchema, FiniteSchema, FiniteSchema]) }).strict(),
  z.object({ type: z.literal("transform2d"), x: Vector2Schema, y: Vector2Schema, origin: Vector2Schema }).strict(),
  z.object({ type: z.literal("basis"), x: Vector3Schema, y: Vector3Schema, z: Vector3Schema }).strict(),
  z.object({ type: z.literal("transform3d"), basis: z.object({ x: Vector3Schema, y: Vector3Schema, z: Vector3Schema }).strict(), origin: Vector3Schema }).strict(),
  z.object({ type: z.literal("projection"), x: Vector4Schema, y: Vector4Schema, z: Vector4Schema, w: Vector4Schema }).strict(),
] as const;

const PackedTagSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("packed_byte_array"), values: z.array(z.number().int().min(0).max(255)).max(4_096) }).strict(),
  z.object({ type: z.literal("packed_int32_array"), values: z.array(z.number().int().min(-2_147_483_648).max(2_147_483_647)).max(4_096) }).strict(),
  z.object({ type: z.literal("packed_int64_array"), values: z.array(z.number().int().safe()).max(4_096) }).strict(),
  z.object({ type: z.literal("packed_float32_array"), values: z.array(FiniteSchema).max(4_096) }).strict(),
  z.object({ type: z.literal("packed_float64_array"), values: z.array(FiniteSchema).max(4_096) }).strict(),
  z.object({ type: z.literal("packed_string_array"), values: z.array(z.string().max(16_384)).max(4_096) }).strict(),
  z.object({ type: z.literal("packed_vector2_array"), values: z.array(Vector2Schema).max(4_096) }).strict(),
  z.object({ type: z.literal("packed_vector3_array"), values: z.array(Vector3Schema).max(4_096) }).strict(),
  z.object({ type: z.literal("packed_color_array"), values: z.array(z.object({ r: FiniteSchema, g: FiniteSchema, b: FiniteSchema, a: FiniteSchema }).strict()).max(4_096) }).strict(),
]);

export const ExtendedEditorVariantSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string().max(16_384),
  ...NumericTagSchemas,
  PackedTagSchema,
  z.object({ type: z.literal("node_path"), value: NodePathSchema }).strict(),
  z.object({ type: z.literal("string_name"), value: z.string().max(16_384) }).strict(),
  z.object({ type: z.literal("resource_ref"), path: ResourcePathSchema, expectedType: IdentifierSchema.optional() }).strict(),
  z.array(ExtendedEditorVariantSchema).max(256),
  z.record(z.string().min(1).max(128), ExtendedEditorVariantSchema)
    .refine((value) => Object.keys(value).length <= 256 && !("type" in value), { message: "Variant dictionary exceeds 256 entries or uses a reserved type key" }),
]));

const ResourceBase = {
  target: ResourceLocatorSchema,
  importExpectation: ImportExpectationSchema.optional(),
};

const ResourceSchemas = [
  z.object({ operation: z.literal("set_resource_property"), ...ResourceBase, property: PropertyNameSchema, value: ExtendedEditorVariantSchema }).strict(),
  z.object({ operation: z.literal("set_resource_metadata"), ...ResourceBase, key: MetadataKeySchema, value: ExtendedEditorVariantSchema }).strict(),
  z.object({ operation: z.literal("remove_resource_metadata"), ...ResourceBase, key: MetadataKeySchema }).strict(),
  z.object({ operation: z.literal("assign_resource_reference"), ...ResourceBase, property: PropertyNameSchema, referencePath: ResourcePathSchema, expectedType: IdentifierSchema.optional() }).strict(),
] as const;

const SceneTarget = { scenePath: ScenePathSchema, nodePath: NodePathSchema };
const ThemeKindSchema = z.enum(["color", "constant", "font", "font_size", "icon", "stylebox"]);
const AnimationTrackTypeSchema = z.enum(["value", "position_3d", "rotation_3d", "scale_3d", "blend_shape", "method", "bezier", "audio", "animation"]);

const TypedSchemas = [
  z.object({ operation: z.literal("configure_control_layout"), ...SceneTarget, anchors: RectSchema.optional(), offsets: RectSchema.optional(), minimumSize: Vector2Schema.optional(), horizontalSizeFlags: z.number().int().min(0).max(255).optional(), verticalSizeFlags: z.number().int().min(0).max(255).optional() }).strict()
    .refine((value) => value.anchors !== undefined || value.offsets !== undefined || value.minimumSize !== undefined || value.horizontalSizeFlags !== undefined || value.verticalSizeFlags !== undefined, { message: "Control layout must change at least one field" }),
  z.object({ operation: z.literal("set_theme_item"), target: ResourceLocatorSchema, itemKind: ThemeKindSchema, themeType: IdentifierSchema, itemName: IdentifierSchema, value: ExtendedEditorVariantSchema }).strict(),
  z.object({ operation: z.literal("remove_theme_item"), target: ResourceLocatorSchema, itemKind: ThemeKindSchema, themeType: IdentifierSchema, itemName: IdentifierSchema }).strict(),
  z.object({ operation: z.literal("upsert_animation"), target: ResourceLocatorSchema, animationName: IdentifierSchema, length: FiniteSchema.nonnegative(), loopMode: z.enum(["none", "linear", "pingpong"]) }).strict(),
  z.object({ operation: z.literal("remove_animation"), target: ResourceLocatorSchema, animationName: IdentifierSchema }).strict(),
  z.object({ operation: z.literal("upsert_animation_track"), target: ResourceLocatorSchema, trackId: IdentifierSchema, trackType: AnimationTrackTypeSchema, trackPath: z.string().min(1).max(512) }).strict(),
  z.object({ operation: z.literal("remove_animation_track"), target: ResourceLocatorSchema, trackId: IdentifierSchema }).strict(),
  z.object({ operation: z.literal("upsert_animation_key"), target: ResourceLocatorSchema, trackId: IdentifierSchema, keyTime: FiniteSchema.nonnegative(), value: ExtendedEditorVariantSchema, transition: FiniteSchema.optional() }).strict(),
  z.object({ operation: z.literal("remove_animation_key"), target: ResourceLocatorSchema, trackId: IdentifierSchema, keyTime: FiniteSchema.nonnegative() }).strict(),
  z.object({ operation: z.literal("configure_animation_tree"), ...SceneTarget, treeRoot: z.object({ type: z.literal("resource_ref"), path: ResourcePathSchema, expectedType: IdentifierSchema.optional() }).strict().optional(), active: z.boolean().optional(), processCallback: z.enum(["physics", "idle", "manual"]).optional(), rootMotionTrack: z.string().max(512).optional(), parameters: z.record(z.string().min(1).max(512), ExtendedEditorVariantSchema).refine((value) => Object.keys(value).length <= 64).optional() }).strict(),
  z.object({ operation: z.literal("set_tile_cells"), ...SceneTarget, cells: z.array(z.object({ coordinates: Vector2Schema, sourceId: z.number().int(), atlasCoordinates: Vector2Schema, alternativeTile: z.number().int().min(0) }).strict()).min(1).max(4_096) }).strict(),
  z.object({ operation: z.literal("erase_tile_cells"), ...SceneTarget, coordinates: z.array(Vector2Schema).min(1).max(4_096) }).strict(),
  z.object({ operation: z.literal("create_custom_resource"), resourcePath: ResPathSchema.refine((value) => value.endsWith(".tres")), className: IdentifierSchema, properties: z.record(IdentifierSchema, ExtendedEditorVariantSchema).refine((value) => Object.keys(value).length <= 256) }).strict(),
] as const;

function sourceContentSchema(): z.ZodString {
  return z.string().refine((value) => !value.includes("\0") && new TextEncoder().encode(value).byteLength <= MAX_SOURCE_BYTES, { message: "Source must be NUL-free and no larger than 192 KiB" });
}

const SourceSchemas = [
  z.object({ operation: z.literal("create_script"), sourcePath: SourcePathSchema.refine((value) => value.endsWith(".gd")), content: sourceContentSchema() }).strict(),
  z.object({ operation: z.literal("replace_script"), sourcePath: SourcePathSchema.refine((value) => value.endsWith(".gd")), expectedSha256: Sha256Schema, content: sourceContentSchema() }).strict(),
  z.object({ operation: z.literal("create_shader"), sourcePath: SourcePathSchema.refine((value) => value.endsWith(".gdshader")), content: sourceContentSchema() }).strict(),
  z.object({ operation: z.literal("replace_shader"), sourcePath: SourcePathSchema.refine((value) => value.endsWith(".gdshader")), expectedSha256: Sha256Schema, content: sourceContentSchema() }).strict(),
] as const;

export const AUTHORING_OPERATIONS = [
  "set_resource_property", "set_resource_metadata", "remove_resource_metadata", "assign_resource_reference",
  "configure_control_layout", "set_theme_item", "remove_theme_item",
  "upsert_animation", "remove_animation", "upsert_animation_track", "remove_animation_track",
  "upsert_animation_key", "remove_animation_key", "configure_animation_tree",
  "set_tile_cells", "erase_tile_cells", "create_custom_resource",
  "create_script", "replace_script", "create_shader", "replace_shader",
] as const;

export const EditorAuthoringStepSchema = z.union([
  ...ResourceSchemas,
  ...TypedSchemas,
  ...SourceSchemas,
]);

export type EditorAuthoringStep = z.infer<typeof EditorAuthoringStepSchema>;
export type ExtendedEditorVariant = z.infer<typeof ExtendedEditorVariantSchema>;
