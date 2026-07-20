import { z } from "zod";

import { RuntimePrimitiveSchema, RuntimeScenePathSchema } from "./runtime.js";

const ResPathSchema = z
  .string()
  .min(6)
  .max(512)
  .startsWith("res://")
  .refine((value) => !value.includes("\0") && !value.slice(6).split("/").includes(".."), {
    message: "Project resource path may not traverse outside the project",
  });

const ProjectNameSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_. -]*$/);
const ArtifactNameSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const ProjectJobTokenSchema = z.string().regex(/^pjob_[A-Za-z0-9_-]{43}$/);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const EvidenceObservationUriSchema = z.string().regex(
  /^godot-mcp:\/\/evidence\/[a-f0-9]{64}\/observations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);

const settingPrefixes = ["application/", "audio/", "display/", "input/", "navigation/", "physics/", "rendering/"];
const deniedSettingPrefixes = [
  "application/run/disable_stdout",
  "application/run/disable_stderr",
  "application/run/main_run_args",
  "application/run/scene",
  "editor_plugins/",
  "autoload/",
  "network/",
  "filesystem/",
  "gdextension/",
];

export const ProjectSettingNameSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9_]+(?:\/[A-Za-z0-9_.-]+)+$/)
  .refine((name) => settingPrefixes.some((prefix) => name.startsWith(prefix)), "Project setting namespace is not allowed")
  .refine((name) => !deniedSettingPrefixes.some((prefix) => name.startsWith(prefix)), "Project setting is operation-sensitive and denied");

const ProjectSettingValueSchema = RuntimePrimitiveSchema.refine((value) =>
	typeof value !== "string" || (!value.includes("\0") && !/^([A-Za-z]:[\\/]|\/|~\/|\\\\|[A-Za-z][A-Za-z0-9+.-]*:)/u.test(value)), {
  message: "Project setting strings may not select host paths or URLs",
});

const ProjectSettingChangeSchema = z.object({
  name: ProjectSettingNameSchema,
  expectedValue: ProjectSettingValueSchema.optional(),
  value: ProjectSettingValueSchema,
}).strict();

const PluginPathSchema = ResPathSchema
  .regex(/^res:\/\/addons\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/plugin\.cfg$/)
  .refine((path) => path !== "res://addons/godot_mcp/plugin.cfg", "The Godot MCP addon is owned by CLI lifecycle");

const MutationBase = {
  idempotencyKey: z.uuid(),
};

const ImportStartSchema = z.object({
  operation: z.literal("import_start"),
  kind: z.enum(["full", "reimport"]),
  resourcePaths: z.array(ResPathSchema).min(1).max(128).optional(),
  deadlineMs: z.number().int().min(1_000).max(120_000).default(120_000),
}).strict().superRefine((input, context) => {
  if (input.kind === "full" && input.resourcePaths !== undefined) {
    context.addIssue({ code: "custom", path: ["resourcePaths"], message: "Full import does not accept selected resource paths" });
  }
  if (input.kind === "reimport" && input.resourcePaths === undefined) {
    context.addIssue({ code: "custom", path: ["resourcePaths"], message: "Selective reimport requires resource paths" });
  }
});

export const ProjectOperationInputSchema = z.union([
  z.object({ operation: z.literal("settings_apply"), ...MutationBase, changes: z.array(ProjectSettingChangeSchema).min(1).max(32) }).strict(),
  z.object({
    operation: z.literal("plugin_set"),
    ...MutationBase,
    pluginPath: PluginPathSchema,
    expectedEnabled: z.boolean(),
    enabled: z.boolean(),
  }).strict().refine((input) => input.enabled !== input.expectedEnabled, "Plugin operation must change state"),
  ImportStartSchema,
  z.object({
    operation: z.literal("run_start"),
    scenePath: RuntimeScenePathSchema.optional(),
    headless: z.boolean().default(true),
    deadlineMs: z.number().int().min(1_000).max(120_000).default(120_000),
  }).strict(),
  z.object({
    operation: z.literal("build_start"),
    kind: z.literal("solutions"),
    deadlineMs: z.number().int().min(1_000).max(120_000).default(120_000),
  }).strict(),
  z.object({
    operation: z.literal("export_start"),
    preset: ProjectNameSchema,
    mode: z.enum(["release", "debug", "pack"]),
    artifactName: ArtifactNameSchema,
    deadlineMs: z.number().int().min(1_000).max(300_000).default(300_000),
  }).strict(),
  z.object({ operation: z.literal("job_status"), jobToken: ProjectJobTokenSchema }).strict(),
  z.object({ operation: z.literal("job_cancel"), jobToken: ProjectJobTokenSchema }).strict(),
  z.object({ operation: z.literal("job_result"), jobToken: ProjectJobTokenSchema }).strict(),
]);

export const ProjectJobReceiptSchema = z.object({
  jobToken: ProjectJobTokenSchema,
  operation: z.enum(["import", "reimport", "run", "build", "export"]),
  state: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  phase: z.enum(["validating", "preparing", "executing", "scanning", "finalizing", "terminal"]),
  progressMillionths: z.number().int().min(0).max(1_000_000),
  cancellationSafe: z.boolean(),
}).strict();

export const ProjectArtifactManifestSchema = z.object({
  uri: z.string().regex(/^godot-mcp:\/\/artifact\/pjob_[A-Za-z0-9_-]{43}\/[a-f0-9]{64}$/),
  name: ArtifactNameSchema,
  byteLength: z.number().int().min(0).max(4 * 1024 * 1024 * 1024),
  sha256: Sha256Schema,
  entryCount: z.number().int().min(1).max(10_000),
  leakFree: z.boolean(),
}).strict();

export const ProjectOperationResultSchema = ProjectJobReceiptSchema.extend({
  state: z.enum(["completed", "failed", "cancelled"]),
  phase: z.literal("terminal"),
  exitCode: z.number().int().min(0).max(255).nullable(),
  partialEffects: z.boolean(),
  rollback: z.enum(["not_needed", "succeeded", "failed", "not_attempted"]),
  evidence: z.array(EvidenceObservationUriSchema).max(16),
  artifact: ProjectArtifactManifestSchema.optional(),
}).strict();

const ProjectMutationRollbackSchema = z.enum(["not_needed", "succeeded", "failed"]);

export const ProjectMutationResultSchema = z.union([
  z.object({
    operation: z.literal("settings_apply"),
    changes: z.array(z.object({
      settingNameSha256: Sha256Schema,
      preimageSha256: Sha256Schema,
      postimageSha256: Sha256Schema,
    }).strict()).min(1).max(32),
    rollback: ProjectMutationRollbackSchema,
  }).strict(),
  z.object({
    operation: z.literal("plugin_set"),
    pluginSha256: Sha256Schema,
    enabled: z.boolean(),
    rollback: ProjectMutationRollbackSchema,
  }).strict(),
]);

export type ProjectOperationInput = z.infer<typeof ProjectOperationInputSchema>;
export type ProjectJobReceipt = z.infer<typeof ProjectJobReceiptSchema>;
export type ProjectArtifactManifest = z.infer<typeof ProjectArtifactManifestSchema>;
export type ProjectOperationResult = z.infer<typeof ProjectOperationResultSchema>;
export type ProjectMutationResult = z.infer<typeof ProjectMutationResultSchema>;
