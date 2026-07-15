import { z } from "zod";

const ResPathSchema = z
  .string()
  .min(6)
  .max(512)
  .startsWith("res://")
  .refine((value) => !value.includes("\0") && !value.slice("res://".length).split("/").includes(".."), {
    message: "res:// path may not traverse outside the project",
  });

const NodePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.split("/").includes(".."), {
    message: "NodePath may not contain parent traversal",
  });

const CursorSchema = z.string().max(256).optional();

export const EditorQueryInputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("editor_state") }).strict(),
  z
    .object({
      operation: z.literal("scene_tree"),
      scenePath: ResPathSchema.optional(),
      maxDepth: z.number().int().min(0).max(32).default(12),
      maxNodes: z.number().int().min(1).max(1000).default(500),
    })
    .strict(),
  z
    .object({
      operation: z.literal("node"),
      scenePath: ResPathSchema,
      nodePath: NodePathSchema,
      includeProperties: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      operation: z.literal("resources"),
      prefix: ResPathSchema.default("res://"),
      kinds: z
        .array(z.enum(["scene", "script", "resource", "shader", "texture", "audio", "other"]))
        .max(7)
        .optional(),
      cursor: CursorSchema,
      limit: z.number().int().min(1).max(2000).default(200),
    })
    .strict(),
  z
    .object({
      operation: z.literal("project_settings"),
      prefix: z.enum([
        "application/",
        "audio/",
        "display/",
        "input/",
        "navigation/",
        "physics/",
        "rendering/",
      ]),
      cursor: CursorSchema,
      limit: z.number().int().min(1).max(2000).default(200),
    })
    .strict(),
  z
    .object({
      operation: z.literal("diagnostics"),
      afterSequence: z.number().int().min(0).default(0),
      levels: z
        .array(z.enum(["log", "warning", "error", "script", "shader"]))
        .min(1)
        .max(5)
        .default(["log", "warning", "error", "script", "shader"]),
      limit: z.number().int().min(1).max(500).default(100),
    })
    .strict(),
]);

export const EditorCaptureInputSchema = z
  .object({
    viewport: z.enum(["2d", "3d"]),
    viewportIndex: z.number().int().min(0).max(3).optional(),
    maxWidth: z.number().int().min(1).max(2048).default(1280),
    maxHeight: z.number().int().min(1).max(2048).default(720),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.viewport === "2d" && value.viewportIndex !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["viewportIndex"],
        message: "viewportIndex is valid only for 3d",
      });
    }
  });

export const BridgeCommandChunkSchema = z
  .object({
    requestId: z.uuid(),
    index: z.number().int().min(0).max(15),
    total: z.number().int().min(1).max(16),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    data: z.string().max(700_000),
  })
  .strict();

export const BridgeCommandResultSchema = z
  .object({
    requestId: z.uuid(),
    ok: z.boolean(),
    data: z.unknown().optional(),
    binary: z
      .object({
        size: z.number().int().min(1).max(8 * 1024 * 1024),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        chunks: z.number().int().min(1).max(16),
      })
      .strict()
      .optional(),
    error: z
      .object({
        code: z.enum([
          "INVALID_REQUEST",
          "PAYLOAD_TOO_LARGE",
          "CONFLICT",
          "TARGET_NOT_FOUND",
          "TIMEOUT",
          "GODOT_RUNTIME_ERROR",
        ]),
        message: z.string().max(4096),
        retryable: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ok === (value.error !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "success requires no error and failure requires an error",
      });
    }
  });

export type EditorQueryInput = z.infer<typeof EditorQueryInputSchema>;
export type EditorCaptureInput = z.infer<typeof EditorCaptureInputSchema>;
export type BridgeCommandChunk = z.infer<typeof BridgeCommandChunkSchema>;
export type BridgeCommandResult = z.infer<typeof BridgeCommandResultSchema>;
