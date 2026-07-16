import { authorize, INPUT_POLICY } from "@godot-mcp/control-plane";
import { InputOperationInputSchema, InputTraceSchema } from "@godot-mcp/protocol";
import { describe, expect, it } from "vitest";

const handle = { runId: "019f644c-1379-79c0-825e-66a4b7653bd1", generation: 1 };
const modifiers = { alt: false, ctrl: false, meta: false, shift: false };

describe("hostile runtime input boundaries", () => {
  it.each([
    { operation: "send", handle, event: { type: "InputEventKey", keycode: 65, pressed: true } },
    { operation: "send", handle, event: { type: "key", keycode: 65, pressed: true, text: "forbidden" } },
    { operation: "send", handle, event: { type: "action", action: "", pressed: true } },
    { operation: "send", handle, event: { type: "action", action: "jump\0escape", pressed: true } },
    { operation: "send", handle, event: { type: "mouse_motion", position: { x: Number.NaN, y: 0 } } },
    { operation: "send", handle, event: { type: "mouse_button", position: { x: 0, y: 0 }, buttonIndex: 10, pressed: true } },
    { operation: "send", handle, event: { type: "joypad_motion", device: 8, axis: 0, axisValueMillionths: 0 } },
    { operation: "send", handle, event: { type: "touch", position: { x: 0, y: 0 }, viewportPath: "../Outside", index: 0, pressed: true } },
    { operation: "send", handle, event: { type: "touch", position: { x: 0, y: 0 }, viewportPath: "Node:property", index: 0, pressed: true } },
    { operation: "send", handle, event: { type: "touch", position: { x: 0, y: 0 }, index: 10, pressed: true } },
    { operation: "sequence", handle, events: [
      { frameOffset: 2, event: { type: "key", keycode: 65, pressed: true, modifiers } },
      { frameOffset: 1, event: { type: "key", keycode: 65, pressed: false, modifiers } },
    ] },
    { operation: "sequence", handle, timeoutMs: 30_001, events: [{ frameOffset: 0, event: { type: "key", keycode: 65, pressed: true, modifiers } }] },
    { operation: "sequence", handle, events: [{ frameOffset: 1_801, event: { type: "key", keycode: 65, pressed: true, modifiers } }] },
    { operation: "replay", handle, trace: { schemaVersion: 2, events: [] } },
  ])("rejects hostile input %# before dispatch", (input) => {
    expect(() => InputOperationInputSchema.parse(input)).toThrow();
  });

  it("rejects oversized batches and trace fields", () => {
    const event = { frameOffset: 0, event: { type: "action" as const, action: "a".repeat(128), pressed: true, strengthMillionths: 1_000_000 } };
    expect(() => InputOperationInputSchema.parse({ operation: "sequence", handle, events: Array.from({ length: 257 }, () => event) })).toThrow();
    expect(() => InputTraceSchema.parse({ schemaVersion: 1, events: Array.from({ length: 256 }, (_, index) => ({
      frameOffset: index,
      event: { ...event.event, action: `${index}`.padEnd(128, "x") },
    })) })).not.toThrow();
    const huge = { schemaVersion: 1, events: Array.from({ length: 256 }, (_, index) => ({
      frameOffset: index,
      event: { type: "mouse_motion", position: { x: 0, y: 0 }, viewportPath: "x".repeat(513), coordinateSpace: "viewport", relative: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, pressureMillionths: 0, tiltMillionths: { x: 0, y: 0 }, modifiers },
    })) };
    expect(() => InputTraceSchema.parse(huge)).toThrow();
  });

  it("requires both runtime_control and the input pack", () => {
    expect(() => authorize({ tiers: ["observe"], packs: ["core", "input"] }, INPUT_POLICY)).toThrow();
    expect(() => authorize({ tiers: ["observe", "runtime_control"], packs: ["core"] }, INPUT_POLICY)).toThrow();
    expect(() => authorize({ tiers: ["observe", "runtime_control"], packs: ["core", "input"] }, INPUT_POLICY)).not.toThrow();
  });
});
