import { z } from "zod";

const RuntimeScenePathSchema = z
  .string()
  .min(8)
  .max(512)
  .startsWith("res://")
  .endsWith(".tscn")
  .refine((value) => !value.includes("\0") && !value.slice(6).split("/").includes(".."), {
    message: "Runtime scene path may not traverse outside the project",
  });

const RuntimeNodePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes(":") &&
      !value.includes("\0") &&
      !value.split("/").includes(".."),
    { message: "Runtime node path must be relative and contain no traversal or subnames" },
  );

const PrimitiveSchema = z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()]);
const SafeRuntimePropertyPatternSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (pattern) =>
      !/[\\+{}()|]/.test(pattern) &&
      (pattern.match(/\*/g)?.length ?? 0) <= 1 &&
      !pattern.includes("**") &&
      !pattern.includes("*?") &&
      !pattern.includes("?*"),
    { message: "Runtime property pattern uses unsupported regex features" },
  );

export const RuntimeHandleSchema = z
  .object({
    runId: z.uuid(),
    generation: z.number().int().min(1),
  })
  .strict();

const RuntimeWaitConditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("node_exists"), nodePath: RuntimeNodePathSchema }).strict(),
  z.object({ type: z.literal("node_missing"), nodePath: RuntimeNodePathSchema }).strict(),
  z
    .object({
      type: z.literal("property_equals"),
      nodePath: RuntimeNodePathSchema,
      property: z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      value: PrimitiveSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("property_matches"),
      nodePath: RuntimeNodePathSchema,
      property: z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      pattern: SafeRuntimePropertyPatternSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("signal_emitted"),
      nodePath: RuntimeNodePathSchema,
      signal: z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    })
    .strict(),
  z
    .object({
      type: z.literal("log_matches"),
      pattern: z.string().min(1).max(256),
      level: z.enum(["log", "warning", "error", "script", "shader"]).optional(),
    })
    .strict(),
  z.object({ type: z.literal("frames_elapsed"), frames: z.number().int().min(1).max(10_000) }).strict(),
]);

const RuntimeHandleOperationSchema = <T extends "pause" | "resume" | "stop">(operation: T) =>
  z.object({ operation: z.literal(operation), handle: RuntimeHandleSchema }).strict();

export const RuntimeOperationInputSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("launch"),
      scenePath: RuntimeScenePathSchema,
      startupTimeoutMs: z.number().int().min(1_000).max(30_000).default(15_000),
    })
    .strict(),
  z.object({ operation: z.literal("status"), handle: RuntimeHandleSchema.optional() }).strict(),
  z
    .object({
      operation: z.literal("tree"),
      handle: RuntimeHandleSchema,
      root: RuntimeNodePathSchema.default("."),
      maxDepth: z.number().int().min(0).max(32).default(12),
      maxNodes: z.number().int().min(1).max(1_000).default(500),
    })
    .strict(),
  z
    .object({
      operation: z.literal("node"),
      handle: RuntimeHandleSchema,
      nodePath: RuntimeNodePathSchema,
      includeProperties: z.boolean().default(true),
      includeSignals: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      operation: z.literal("logs"),
      handle: RuntimeHandleSchema,
      afterSequence: z.number().int().min(0).default(0),
      levels: z
        .array(z.enum(["log", "warning", "error", "script", "shader"]))
        .min(1)
        .max(5)
        .default(["log", "warning", "error", "script", "shader"]),
      limit: z.number().int().min(1).max(500).default(100),
    })
    .strict(),
  z
    .object({
      operation: z.literal("wait"),
      handle: RuntimeHandleSchema,
      timeoutMs: z.number().int().min(1).max(30_000).default(10_000),
      condition: RuntimeWaitConditionSchema,
    })
    .strict(),
  RuntimeHandleOperationSchema("pause"),
  RuntimeHandleOperationSchema("resume"),
  z
    .object({
      operation: z.literal("step"),
      handle: RuntimeHandleSchema,
      frames: z.number().int().min(1).max(120),
    })
    .strict(),
  RuntimeHandleOperationSchema("stop"),
]);

export const RuntimeCaptureInputSchema = z
  .object({
    handle: RuntimeHandleSchema,
    maxWidth: z.number().int().min(1).max(2048).default(1280),
    maxHeight: z.number().int().min(1).max(2048).default(720),
    frameCount: z.number().int().min(1).max(8).default(1),
    intervalFrames: z.number().int().min(1).max(120).default(1),
    advancePaused: z.boolean().default(false),
  })
  .strict();

export const RuntimeCaptureFrameMetadataSchema = z
  .object({
    mimeType: z.literal("image/png"),
    width: z.number().int().min(1).max(2048),
    height: z.number().int().min(1).max(2048),
    byteLength: z.number().int().min(1).max(8 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    frameIndex: z.number().int().min(0).max(7),
  })
  .strict();

export const RuntimeCommandSchema = z
  .object({
    handle: RuntimeHandleSchema,
    requestId: z.uuid(),
    sequence: z.number().int().positive(),
    deadlineUnixMs: z.number().int().positive(),
    operation: z.string().min(1).max(64),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();

export type RuntimeHandle = z.infer<typeof RuntimeHandleSchema>;
export type RuntimeOperationInput = z.infer<typeof RuntimeOperationInputSchema>;
export type RuntimeCaptureInput = z.infer<typeof RuntimeCaptureInputSchema>;
export type RuntimeCaptureFrameMetadata = z.infer<typeof RuntimeCaptureFrameMetadataSchema>;
export type RuntimeCommand = z.infer<typeof RuntimeCommandSchema>;
