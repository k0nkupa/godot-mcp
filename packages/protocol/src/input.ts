import { z } from "zod";

import { RuntimeHandleSchema } from "./runtime.js";

const MAX_COORDINATE = 8_192;
const MAX_TRACE_BYTES = 256 * 1024;
const ONE_MILLION = 1_000_000;

const BoundedVectorSchema = z.object({
  x: z.number().int().min(-MAX_COORDINATE).max(MAX_COORDINATE),
  y: z.number().int().min(-MAX_COORDINATE).max(MAX_COORDINATE),
}).strict();

const NormalizedVectorSchema = z.object({
  x: z.number().int().min(0).max(ONE_MILLION),
  y: z.number().int().min(0).max(ONE_MILLION),
}).strict();

const PositionedVectorSchema = z.object({
  x: z.number().int().min(-MAX_COORDINATE).max(ONE_MILLION),
  y: z.number().int().min(-MAX_COORDINATE).max(ONE_MILLION),
}).strict();

const DeltaVectorSchema = z.object({
  x: z.number().int().min(-100).max(100),
  y: z.number().int().min(-100).max(100),
}).strict();

const ViewportPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes(":") &&
      !value.includes("\0") &&
      !value.split("/").includes(".."),
    { message: "Input viewport path must be relative and contain no traversal or subnames" },
  );

const ModifiersSchema = z.object({
  alt: z.boolean().default(false),
  ctrl: z.boolean().default(false),
  meta: z.boolean().default(false),
  shift: z.boolean().default(false),
}).strict().default({ alt: false, ctrl: false, meta: false, shift: false });

const positionedFields = {
  position: PositionedVectorSchema,
  viewportPath: ViewportPathSchema.default("."),
  coordinateSpace: z.enum(["viewport", "normalized", "embedder"]).default("viewport"),
};

const ActionEventSchema = z.object({
  type: z.literal("action"),
  action: z.string().min(1).max(128).refine((value) => !value.includes("\0")),
  pressed: z.boolean(),
  strengthMillionths: z.number().int().min(0).max(ONE_MILLION).default(ONE_MILLION),
}).strict();

const KeyEventSchema = z.object({
  type: z.literal("key"),
  keycode: z.number().int().min(1).max(0x7fffffff),
  physicalKeycode: z.number().int().min(0).max(0x7fffffff).default(0),
  unicode: z.number().int().min(0).max(0x10ffff).default(0),
  pressed: z.boolean(),
  echo: z.boolean().default(false),
  modifiers: ModifiersSchema,
}).strict();

const MouseButtonEventSchema = z.object({
  type: z.literal("mouse_button"),
  ...positionedFields,
  buttonIndex: z.number().int().min(1).max(9),
  pressed: z.boolean(),
  doubleClick: z.boolean().default(false),
  factorMillionths: z.number().int().min(0).max(100 * ONE_MILLION).default(ONE_MILLION),
  modifiers: ModifiersSchema,
}).strict();

const MouseMotionEventSchema = z.object({
  type: z.literal("mouse_motion"),
  ...positionedFields,
  relative: BoundedVectorSchema.default({ x: 0, y: 0 }),
  velocity: BoundedVectorSchema.default({ x: 0, y: 0 }),
  pressureMillionths: z.number().int().min(0).max(ONE_MILLION).default(0),
  tiltMillionths: z.object({
    x: z.number().int().min(-ONE_MILLION).max(ONE_MILLION),
    y: z.number().int().min(-ONE_MILLION).max(ONE_MILLION),
  }).strict().default({ x: 0, y: 0 }),
  modifiers: ModifiersSchema,
}).strict();

const ScrollEventSchema = z.object({
  type: z.literal("scroll"),
  ...positionedFields,
  delta: DeltaVectorSchema.refine((value) => value.x !== 0 || value.y !== 0, {
    message: "Scroll delta must not be zero",
  }),
  modifiers: ModifiersSchema,
}).strict();

const TouchEventSchema = z.object({
  type: z.literal("touch"),
  ...positionedFields,
  index: z.number().int().min(0).max(9),
  pressed: z.boolean(),
  canceled: z.boolean().default(false),
  doubleTap: z.boolean().default(false),
}).strict();

const TouchDragEventSchema = z.object({
  type: z.literal("touch_drag"),
  ...positionedFields,
  index: z.number().int().min(0).max(9),
  relative: BoundedVectorSchema.default({ x: 0, y: 0 }),
  velocity: BoundedVectorSchema.default({ x: 0, y: 0 }),
  pressureMillionths: z.number().int().min(0).max(ONE_MILLION).default(0),
  tiltMillionths: z.object({
    x: z.number().int().min(-ONE_MILLION).max(ONE_MILLION),
    y: z.number().int().min(-ONE_MILLION).max(ONE_MILLION),
  }).strict().default({ x: 0, y: 0 }),
}).strict();

const PanGestureEventSchema = z.object({
  type: z.literal("pan_gesture"),
  ...positionedFields,
  delta: DeltaVectorSchema,
}).strict();

const MagnifyGestureEventSchema = z.object({
  type: z.literal("magnify_gesture"),
  ...positionedFields,
  factorMillionths: z.number().int().min(10_000).max(16 * ONE_MILLION),
}).strict();

const JoypadButtonEventSchema = z.object({
  type: z.literal("joypad_button"),
  device: z.number().int().min(0).max(7),
  buttonIndex: z.number().int().min(0).max(127),
  pressed: z.boolean(),
  pressureMillionths: z.number().int().min(0).max(ONE_MILLION).default(0),
}).strict();

const JoypadMotionEventSchema = z.object({
  type: z.literal("joypad_motion"),
  device: z.number().int().min(0).max(7),
  axis: z.number().int().min(0).max(9),
  axisValueMillionths: z.number().int().min(-ONE_MILLION).max(ONE_MILLION),
}).strict();

export const InputEventSchema = z.discriminatedUnion("type", [
  ActionEventSchema,
  KeyEventSchema,
  MouseButtonEventSchema,
  MouseMotionEventSchema,
  ScrollEventSchema,
  TouchEventSchema,
  TouchDragEventSchema,
  PanGestureEventSchema,
  MagnifyGestureEventSchema,
  JoypadButtonEventSchema,
  JoypadMotionEventSchema,
]).superRefine((event, context) => {
  if (!("position" in event)) return;
  const parsed = (event.coordinateSpace === "normalized" ? NormalizedVectorSchema : BoundedVectorSchema).safeParse(event.position);
  if (!parsed.success) {
    context.addIssue({
      code: "custom",
      message: event.coordinateSpace === "normalized"
        ? "Normalized coordinates must be integer millionths between zero and one million"
        : "Viewport coordinates must be bounded pixels",
      path: ["position"],
    });
  }
});

export const InputTraceEventSchema = z.object({
  frameOffset: z.number().int().min(0).max(1_800),
  event: InputEventSchema,
}).strict();

const InputTraceEventsSchema = z.array(InputTraceEventSchema).max(256).superRefine((events, context) => {
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.frameOffset < events[index - 1]!.frameOffset) {
      context.addIssue({ code: "custom", message: "Input trace frame offsets must be nondecreasing", path: [index, "frameOffset"] });
    }
  }
});

export const InputTraceSchema = z.object({
  schemaVersion: z.literal(1),
  events: InputTraceEventsSchema,
}).strict().superRefine((trace, context) => {
  if (new TextEncoder().encode(JSON.stringify(trace)).byteLength > MAX_TRACE_BYTES) {
    context.addIssue({ code: "custom", message: "Input trace exceeds 256 KiB" });
  }
});

export const InputOperationInputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("send"), handle: RuntimeHandleSchema, event: InputEventSchema }).strict(),
  z.object({
    operation: z.literal("sequence"),
    handle: RuntimeHandleSchema,
    mode: z.enum(["realtime", "deterministic"]).default("realtime"),
    timeoutMs: z.number().int().min(1).max(30_000).default(10_000),
    events: InputTraceEventsSchema.min(1),
  }).strict(),
  z.object({ operation: z.literal("record_start"), handle: RuntimeHandleSchema }).strict(),
  z.object({ operation: z.literal("record_stop"), handle: RuntimeHandleSchema }).strict(),
  z.object({
    operation: z.literal("replay"),
    handle: RuntimeHandleSchema,
    mode: z.literal("deterministic").default("deterministic"),
    timeoutMs: z.number().int().min(1).max(30_000).default(10_000),
    trace: InputTraceSchema,
  }).strict(),
]);

const InputEventKindSchema = z.enum([
  "action",
  "key",
  "mouse_button",
  "mouse_motion",
  "scroll",
  "touch",
  "touch_drag",
  "pan_gesture",
  "magnify_gesture",
  "joypad_button",
  "joypad_motion",
]);

const InputEventReceiptSchema = z.object({
  index: z.number().int().min(0).max(255),
  kind: InputEventKindSchema,
  scheduledFrame: z.number().int().min(0).max(1_800),
  deliveredFrame: z.number().int().min(0),
  viewportPath: ViewportPathSchema.optional(),
  coordinateSpace: z.enum(["viewport", "normalized", "embedder"]).optional(),
}).strict();

export const InputReceiptSchema = z.object({
  handle: RuntimeHandleSchema,
  operation: z.enum(["send", "sequence", "record_start", "record_stop", "replay"]),
  eventCount: z.number().int().min(0).max(256),
  deliveredCount: z.number().int().min(0).max(256),
  deterministic: z.boolean(),
  events: z.array(InputEventReceiptSchema).max(256),
  releases: z.array(InputEventKindSchema).max(256),
  traceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  recording: z.boolean(),
}).strict().refine((receipt) => receipt.deliveredCount <= receipt.eventCount, {
  message: "Delivered input count exceeds requested event count",
});

export const InputOperationResultSchema = z.object({
  receipt: InputReceiptSchema,
  trace: InputTraceSchema.optional(),
}).strict().superRefine((result, context) => {
  if (result.receipt.operation === "record_stop" && result.trace === undefined) {
    context.addIssue({ code: "custom", message: "record_stop must return its trace", path: ["trace"] });
  }
  if (result.receipt.operation !== "record_stop" && result.trace !== undefined) {
    context.addIssue({ code: "custom", message: "Only record_stop may return a trace", path: ["trace"] });
  }
});

export type InputEvent = z.infer<typeof InputEventSchema>;
export type InputTraceEvent = z.infer<typeof InputTraceEventSchema>;
export type InputTrace = z.infer<typeof InputTraceSchema>;
export type InputOperationInput = z.infer<typeof InputOperationInputSchema>;
export type InputReceipt = z.infer<typeof InputReceiptSchema>;
export type InputOperationResult = z.infer<typeof InputOperationResultSchema>;
