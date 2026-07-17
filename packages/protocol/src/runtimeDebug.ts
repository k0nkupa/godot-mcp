import { z } from "zod";

import { RuntimeHandleSchema } from "./runtimeShared.js";

const opaqueToken = (prefix: "dft" | "dvt") =>
  z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]{43}$`));

export const DebugFrameTokenSchema = opaqueToken("dft");
export const DebugVariableTokenSchema = opaqueToken("dvt");

const DebugSourcePathSchema = z
  .string()
  .min(9)
  .max(512)
  .startsWith("res://")
  .endsWith(".gd")
  .refine((value) => {
    if (value.includes("\0") || value.includes("\\")) return false;
    const segments = value.slice(6).split("/");
    if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return false;
    return !value.startsWith("res://addons/godot_mcp/");
  }, { message: "Debugger source must be a canonical project-local GDScript outside the Godot MCP addon" });

const RuntimeBreakpointSchema = z
  .object({
    sourcePath: DebugSourcePathSchema,
    line: z.number().int().min(1).max(1_000_000),
  })
  .strict();

const BreakpointsSetSchema = z
  .object({
    operation: z.literal("debug_breakpoints_set"),
    handle: RuntimeHandleSchema,
    breakpoints: z.array(RuntimeBreakpointSchema).max(64),
  })
  .strict()
  .refine((input) => new Set(input.breakpoints.map((entry) => entry.sourcePath)).size <= 16, {
    message: "Debugger requests may target at most 16 source files",
  })
  .refine((input) => {
    const identities = input.breakpoints.map((entry) => `${entry.sourcePath}:${entry.line}`);
    return new Set(identities).size === identities.length;
  }, { message: "Debugger breakpoints must be unique" });

const DebugHandleOperationSchema = <T extends "debug_status" | "debug_pause" | "debug_continue" | "debug_step_over" | "debug_step_into">(operation: T) =>
  z.object({ operation: z.literal(operation), handle: RuntimeHandleSchema }).strict();

const PageSchema = {
  offset: z.number().int().min(0).max(2_048).default(0),
  limit: z.number().int().min(1).max(256).default(100),
};

const DebugWatchSegmentSchema = z.union([
  z.string().min(1).max(128).refine((value) => !value.includes("\0")),
  z.number().int().min(0).max(1_000_000),
]);

const DebugWatchSelectorSchema = z
  .object({
    scope: z.enum(["locals", "members", "globals"]),
    path: z.array(DebugWatchSegmentSchema).min(1).max(8),
  })
  .strict();

export const RuntimeDebugOperationInputSchema = z.discriminatedUnion("operation", [
  BreakpointsSetSchema,
  DebugHandleOperationSchema("debug_status"),
  z
    .object({
      operation: z.literal("debug_wait"),
      handle: RuntimeHandleSchema,
      afterSequence: z.number().int().min(0).default(0),
      timeoutMs: z.number().int().min(1).max(30_000).default(10_000),
    })
    .strict(),
  DebugHandleOperationSchema("debug_pause"),
  DebugHandleOperationSchema("debug_continue"),
  DebugHandleOperationSchema("debug_step_over"),
  DebugHandleOperationSchema("debug_step_into"),
  z
    .object({
      operation: z.literal("debug_stack"),
      handle: RuntimeHandleSchema,
      offset: z.number().int().min(0).max(64).default(0),
      limit: z.number().int().min(1).max(64).default(64),
    })
    .strict(),
  z
    .object({
      operation: z.literal("debug_variables"),
      handle: RuntimeHandleSchema,
      frameToken: DebugFrameTokenSchema,
      scope: z.enum(["locals", "members", "globals"]),
      ...PageSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("debug_children"),
      handle: RuntimeHandleSchema,
      variableToken: DebugVariableTokenSchema,
      ...PageSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("debug_watch"),
      handle: RuntimeHandleSchema,
      frameToken: DebugFrameTokenSchema,
      selectors: z.array(DebugWatchSelectorSchema).min(1).max(32),
    })
    .strict(),
]);

export const RUNTIME_DEBUG_OPERATIONS = [
  "debug_breakpoints_set",
  "debug_status",
  "debug_wait",
  "debug_pause",
  "debug_continue",
  "debug_step_over",
  "debug_step_into",
  "debug_stack",
  "debug_variables",
  "debug_children",
  "debug_watch",
] as const;

export type DebugFrameToken = z.infer<typeof DebugFrameTokenSchema>;
export type DebugVariableToken = z.infer<typeof DebugVariableTokenSchema>;
export type RuntimeDebugOperationInput = z.infer<typeof RuntimeDebugOperationInputSchema>;
