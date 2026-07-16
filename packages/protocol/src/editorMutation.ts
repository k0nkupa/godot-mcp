import { z } from "zod";

const MAX_MUTATION_BYTES = 256 * 1024;
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const ResPathSchema = z
  .string()
  .min(7)
  .max(512)
  .startsWith("res://")
  .refine(
    (value) =>
      !value.includes("\0") &&
      !value.slice("res://".length).split("/").includes("..") &&
      !value.endsWith("/"),
    { message: "res:// path may not traverse outside the project or name a directory" },
  );

const ScenePathSchema = ResPathSchema.refine(
  (value) => value.endsWith(".tscn") || value.endsWith(".scn"),
  { message: "Scene path must end in .tscn or .scn" },
);

const ResourcePathSchema = ResPathSchema.refine(
  (value) => value.endsWith(".tres") || value.endsWith(".res"),
  { message: "Resource path must end in .tres or .res" },
);

const NodePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes(":") &&
      !value.includes("\0") &&
      !value.split("/").includes(".."),
    { message: "NodePath must be relative and contain no traversal or subnames" },
  );

const IdentifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const NodeNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !value.includes("/") && !value.includes(":") && !value.includes("\0") && value !== "." && value !== "..", {
    message: "Node name contains reserved characters",
  });
const PropertyNameSchema = z.string().min(1).max(256).refine((value) => !value.includes(":") && !value.includes("\0"));
const MetadataKeySchema = z.string().min(1).max(128).refine((value) => !value.includes("\0"));

export type EditorVariant =
  | null
  | boolean
  | number
  | string
  | { type: "vector2"; x: number; y: number }
  | { type: "vector3"; x: number; y: number; z: number }
  | { type: "color"; r: number; g: number; b: number; a: number }
  | { type: "node_path"; value: string }
  | { type: "resource_ref"; path: string }
  | EditorVariant[]
  | { [key: string]: EditorVariant };

export const EditorVariantSchema: z.ZodType<EditorVariant> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string().max(16_384),
  z.object({ type: z.literal("vector2"), x: z.number().finite(), y: z.number().finite() }).strict(),
  z.object({ type: z.literal("vector3"), x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).strict(),
  z.object({
    type: z.literal("color"),
    r: z.number().finite(),
    g: z.number().finite(),
    b: z.number().finite(),
    a: z.number().finite(),
  }).strict(),
  z.object({ type: z.literal("node_path"), value: NodePathSchema }).strict(),
  z.object({ type: z.literal("resource_ref"), path: ResourcePathSchema }).strict(),
  z.array(EditorVariantSchema).max(256),
  z.record(z.string().min(1).max(128), EditorVariantSchema)
    .refine((value) => Object.keys(value).length <= 256, { message: "Variant dictionary exceeds 256 entries" }),
]));

const SceneStepSchemas = [
  z.object({ operation: z.literal("create_scene"), scenePath: ScenePathSchema, rootClassName: IdentifierSchema, rootName: NodeNameSchema }).strict(),
  z.object({ operation: z.literal("duplicate_scene"), scenePath: ScenePathSchema, destinationPath: ScenePathSchema }).strict(),
  z.object({ operation: z.literal("move_scene"), scenePath: ScenePathSchema, destinationPath: ScenePathSchema }).strict(),
  z.object({ operation: z.literal("delete_scene"), scenePath: ScenePathSchema }).strict(),
] as const;

const ResourceStepSchemas = [
  z.object({ operation: z.literal("create_resource"), resourcePath: ResourcePathSchema, className: IdentifierSchema }).strict(),
  z.object({ operation: z.literal("duplicate_resource"), resourcePath: ResourcePathSchema, destinationPath: ResourcePathSchema }).strict(),
  z.object({ operation: z.literal("move_resource"), resourcePath: ResourcePathSchema, destinationPath: ResourcePathSchema }).strict(),
  z.object({ operation: z.literal("delete_resource"), resourcePath: ResourcePathSchema }).strict(),
] as const;

const NodeStepSchemas = [
  z.object({ operation: z.literal("create_node"), scenePath: ScenePathSchema, parentPath: NodePathSchema, className: IdentifierSchema, name: NodeNameSchema }).strict(),
  z.object({ operation: z.literal("duplicate_node"), scenePath: ScenePathSchema, nodePath: NodePathSchema, parentPath: NodePathSchema, name: NodeNameSchema }).strict(),
  z.object({ operation: z.literal("move_node"), scenePath: ScenePathSchema, nodePath: NodePathSchema, index: z.number().int().min(0).max(9_999) }).strict(),
  z.object({ operation: z.literal("rename_node"), scenePath: ScenePathSchema, nodePath: NodePathSchema, name: NodeNameSchema }).strict(),
  z.object({ operation: z.literal("reparent_node"), scenePath: ScenePathSchema, nodePath: NodePathSchema, parentPath: NodePathSchema, index: z.number().int().min(0).max(9_999) }).strict(),
  z.object({ operation: z.literal("delete_node"), scenePath: ScenePathSchema, nodePath: NodePathSchema }).strict(),
  z.object({ operation: z.literal("set_property"), scenePath: ScenePathSchema, nodePath: NodePathSchema, property: PropertyNameSchema, value: EditorVariantSchema }).strict(),
  z.object({ operation: z.literal("set_metadata"), scenePath: ScenePathSchema, nodePath: NodePathSchema, key: MetadataKeySchema, value: EditorVariantSchema }).strict(),
  z.object({ operation: z.literal("remove_metadata"), scenePath: ScenePathSchema, nodePath: NodePathSchema, key: MetadataKeySchema }).strict(),
  z.object({ operation: z.literal("add_group"), scenePath: ScenePathSchema, nodePath: NodePathSchema, group: NodeNameSchema, persistent: z.boolean().default(true) }).strict(),
  z.object({ operation: z.literal("remove_group"), scenePath: ScenePathSchema, nodePath: NodePathSchema, group: NodeNameSchema }).strict(),
  z.object({ operation: z.literal("connect_signal"), scenePath: ScenePathSchema, nodePath: NodePathSchema, signal: IdentifierSchema, targetPath: NodePathSchema, method: IdentifierSchema, flags: z.number().int().min(0).max(15).default(0) }).strict(),
  z.object({ operation: z.literal("disconnect_signal"), scenePath: ScenePathSchema, nodePath: NodePathSchema, signal: IdentifierSchema, targetPath: NodePathSchema, method: IdentifierSchema }).strict(),
  z.object({ operation: z.literal("set_owner"), scenePath: ScenePathSchema, nodePath: NodePathSchema, ownerPath: NodePathSchema.nullable() }).strict(),
] as const;

export const EditorMutationStepSchema = z.discriminatedUnion("operation", [
  ...SceneStepSchemas,
  ...ResourceStepSchemas,
  ...NodeStepSchemas,
]);

const MutationStepsSchema = z.array(EditorMutationStepSchema).min(1).max(32);

export const EditorMutationInputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("preview"), steps: MutationStepsSchema }).strict(),
  z.object({
    operation: z.literal("apply"),
    idempotencyKey: z.uuid(),
    expectedPlanDigest: Sha256Schema,
    steps: MutationStepsSchema,
  }).strict(),
  z.object({ operation: z.literal("undo"), actionId: z.uuid(), idempotencyKey: z.uuid() }).strict(),
  z.object({ operation: z.literal("redo"), actionId: z.uuid(), idempotencyKey: z.uuid() }).strict(),
]).superRefine((input, context) => {
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > MAX_MUTATION_BYTES) {
    context.addIssue({ code: "custom", message: "Editor mutation request exceeds 256 KiB" });
  }
});

const MutationTargetSchema = z.object({
  kind: z.enum(["scene", "resource", "node", "property", "metadata", "group", "signal", "owner"]),
  path: z.string().min(1).max(512),
  revision: Sha256Schema.nullable(),
}).strict();

const MutationOperationSchema = z.enum([
  "create_scene",
  "duplicate_scene",
  "move_scene",
  "delete_scene",
  "create_resource",
  "duplicate_resource",
  "move_resource",
  "delete_resource",
  "create_node",
  "duplicate_node",
  "move_node",
  "rename_node",
  "reparent_node",
  "delete_node",
  "set_property",
  "set_metadata",
  "remove_metadata",
  "add_group",
  "remove_group",
  "connect_signal",
  "disconnect_signal",
  "set_owner",
]);

const MutationChangeSchema = z.object({
  operation: MutationOperationSchema,
  target: MutationTargetSchema,
  beforeRevision: Sha256Schema.nullable(),
  afterRevision: Sha256Schema.nullable(),
}).strict();

const MutationPreconditionSchema = z.object({
  target: MutationTargetSchema,
  expectedRevision: Sha256Schema.nullable(),
  expectedAbsent: z.boolean(),
}).strict();

const MutationAuditSchema = z.object({
  targetIdentities: z.array(MutationTargetSchema).max(64),
  preconditions: z.array(MutationPreconditionSchema).max(64),
  idempotencyKeySha256: Sha256Schema.nullable(),
  partialEffects: z.boolean(),
  rollback: z.enum(["not_needed", "succeeded", "failed", "not_attempted"]),
}).strict();

const MutationHistorySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("scene"), scenePath: ScenePathSchema }).strict(),
  z.object({ kind: z.literal("global") }).strict(),
]);

export const EditorMutationResultSchema = z.object({
  state: z.enum(["previewed", "applied", "undone", "redone"]),
  planDigest: Sha256Schema.optional(),
  actionId: z.uuid().optional(),
  history: MutationHistorySchema,
  preconditions: z.array(MutationPreconditionSchema).max(64),
  changes: z.array(MutationChangeSchema).max(64),
  warnings: z.array(z.string().max(1_024)).max(32),
  audit: MutationAuditSchema,
}).strict().superRefine((result, context) => {
  if (result.state === "previewed" && result.planDigest === undefined) {
    context.addIssue({ code: "custom", path: ["planDigest"], message: "Preview requires a plan digest" });
  }
  if (result.state !== "previewed" && result.actionId === undefined) {
    context.addIssue({ code: "custom", path: ["actionId"], message: "Mutation result requires an action ID" });
  }
});

export type EditorMutationStep = z.infer<typeof EditorMutationStepSchema>;
export type EditorMutationInput = z.infer<typeof EditorMutationInputSchema>;
export type EditorMutationResult = z.infer<typeof EditorMutationResultSchema>;
