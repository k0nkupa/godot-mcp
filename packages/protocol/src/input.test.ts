import { describe, expect, it } from "vitest";

import {
  InputEventSchema,
  InputOperationInputSchema,
  InputOperationResultSchema,
  InputTraceSchema,
} from "./input.js";

const handle = { runId: "019f644c-1379-79c0-825e-66a4b7653bd1", generation: 1 };
const point = { x: 25, y: 75 };

describe("Phase 4 input schemas", () => {
  it.each([
    { type: "action", action: "phase_4_accept", pressed: true, strengthMillionths: 1_000_000 },
    { type: "key", keycode: 65, pressed: true },
    { type: "mouse_button", buttonIndex: 1, pressed: true, position: point },
    { type: "mouse_motion", position: point, relative: { x: 1, y: -1 }, pressureMillionths: 500_000 },
    { type: "scroll", position: point, delta: { x: 0, y: -2 } },
    { type: "touch", index: 0, position: point, pressed: true },
    { type: "touch_drag", index: 0, position: point, relative: { x: 1, y: 0 }, pressureMillionths: 500_000 },
    { type: "pan_gesture", position: point, delta: { x: 2, y: 3 } },
    { type: "magnify_gesture", position: point, factorMillionths: 1_250_000 },
    { type: "joypad_button", device: 0, buttonIndex: 1, pressed: true, pressureMillionths: 500_000 },
    { type: "joypad_motion", device: 0, axis: 1, axisValueMillionths: -500_000 },
  ])("accepts the $type event", (event) => {
    expect(InputEventSchema.parse(event)).toMatchObject(event);
  });

  it("defaults positioned input to the root viewport coordinate space", () => {
    expect(InputEventSchema.parse({
      type: "mouse_button",
      buttonIndex: 1,
      pressed: true,
      position: { x: 10, y: 20 },
    })).toMatchObject({ viewportPath: ".", coordinateSpace: "viewport" });
  });

  it("accepts simultaneous events and deterministic replay", () => {
    const events = [
      { frameOffset: 0, event: { type: "touch", index: 0, position: point, pressed: true } },
      { frameOffset: 0, event: { type: "touch", index: 1, position: point, pressed: true } },
      { frameOffset: 1, event: { type: "touch", index: 0, position: point, pressed: false } },
      { frameOffset: 1, event: { type: "touch", index: 1, position: point, pressed: false } },
    ];
    expect(InputOperationInputSchema.parse({ operation: "sequence", handle, events })).toMatchObject({
      mode: "realtime",
      timeoutMs: 10_000,
    });
    expect(InputOperationInputSchema.parse({
      operation: "replay",
      handle,
      trace: { schemaVersion: 1, events },
    })).toMatchObject({ operation: "replay", mode: "deterministic", timeoutMs: 10_000 });
  });

  it("allows an empty recording trace but not an empty sequence", () => {
    expect(InputTraceSchema.parse({ schemaVersion: 1, events: [] })).toEqual({
      schemaVersion: 1,
      events: [],
    });
    expect(() => InputOperationInputSchema.parse({ operation: "sequence", handle, events: [] })).toThrow();
  });

  it("rejects decreasing offsets, oversized traces, and excessive active touches", () => {
    expect(() => InputTraceSchema.parse({
      schemaVersion: 1,
      events: [
        { frameOffset: 2, event: { type: "action", action: "jump", pressed: true } },
        { frameOffset: 1, event: { type: "action", action: "jump", pressed: false } },
      ],
    })).toThrow();
    expect(() => InputTraceSchema.parse({
      schemaVersion: 1,
      events: Array.from({ length: 257 }, (_, index) => ({
        frameOffset: index,
        event: { type: "action", action: "jump", pressed: true },
      })),
    })).toThrow();
    expect(() => InputTraceSchema.parse({
      schemaVersion: 1,
      events: Array.from({ length: 11 }, (_, index) => ({
        frameOffset: 0,
        event: { type: "touch", index, position: point, pressed: true },
      })),
    })).toThrow();
  });

  it.each([
    { type: "key", keycode: 65, pressed: true, text: "secret" },
    { type: "mouse_button", buttonIndex: 1, pressed: true, position: { x: Number.NaN, y: 0 } },
    { type: "mouse_motion", position: { x: 1_000_001, y: 0 }, coordinateSpace: "normalized" },
    { type: "touch", index: 10, position: point, pressed: true },
    { type: "joypad_motion", device: 8, axis: 0, axisValueMillionths: 0 },
    { type: "joypad_motion", device: 0, axis: 10, axisValueMillionths: 0 },
    { type: "magnify_gesture", position: point, factorMillionths: 0 },
    { type: "action", action: "jump", pressed: true, strengthMillionths: 0.5 },
    { type: "mouse_button", buttonIndex: 1, pressed: true, position: point, viewportPath: "../Other" },
    { type: "mouse_button", buttonIndex: 1, pressed: true, position: point, viewportPath: "View:secret" },
    { type: "arbitrary", className: "InputEventMIDI" },
  ])("rejects hostile event %#", (event) => {
    expect(() => InputEventSchema.parse(event)).toThrow();
  });

  it("validates summary-only receipts and record-stop traces separately", () => {
    const trace = {
      schemaVersion: 1 as const,
      events: [{ frameOffset: 0, event: { type: "action" as const, action: "jump", pressed: true } }],
    };
    const result = InputOperationResultSchema.parse({
      receipt: {
        handle,
        operation: "record_stop",
        eventCount: 1,
        deliveredCount: 1,
        deterministic: false,
        events: [{ index: 0, kind: "action", scheduledFrame: 0, deliveredFrame: 0 }],
        releases: [],
        traceSha256: "a".repeat(64),
        recording: false,
      },
      trace,
    });
    expect(result.trace).toEqual({
      schemaVersion: 1,
      events: [{ frameOffset: 0, event: { type: "action", action: "jump", pressed: true, strengthMillionths: 1_000_000 } }],
    });
    expect(result.receipt).not.toHaveProperty("rawEvents");
  });
});
