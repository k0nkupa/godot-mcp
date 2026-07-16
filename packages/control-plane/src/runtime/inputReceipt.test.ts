import { describe, expect, it } from "vitest";

import { InputOperationInputSchema } from "@godot-mcp/protocol";

import { summarizeInputForAudit, traceSha256 } from "./inputReceipt.js";

const handle = { runId: "019f644c-1379-79c0-825e-66a4b7653bd1", generation: 1 };

describe("input receipt hashing and audit summaries", () => {
  it("hashes fixed-point traces canonically", () => {
    const first = {
      schemaVersion: 1 as const,
      events: [{
        frameOffset: 0,
        event: { type: "joypad_motion" as const, device: 0, axis: 1, axisValueMillionths: -500_000 },
      }],
    };
    const second = {
      events: [{
        event: { axisValueMillionths: -500_000, axis: 1, device: 0, type: "joypad_motion" as const },
        frameOffset: 0,
      }],
      schemaVersion: 1 as const,
    };
    expect(traceSha256(first)).toBe(traceSha256(second));
    expect(traceSha256(first)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("summarizes event kinds without retaining sensitive input detail", () => {
    const input = InputOperationInputSchema.parse({
      operation: "sequence",
      handle,
      mode: "deterministic",
      events: [
        { frameOffset: 0, event: { type: "action", action: "private_action", pressed: true } },
        { frameOffset: 2, event: { type: "key", keycode: 65, pressed: true } },
        { frameOffset: 2, event: { type: "mouse_button", buttonIndex: 1, pressed: true, position: { x: 44, y: 55 } } },
      ],
    });
    const summary = summarizeInputForAudit(input);
    expect(summary).toEqual({
      handle,
      operation: "sequence",
      mode: "deterministic",
      eventCount: 3,
      eventKinds: { action: 1, key: 1, mouse_button: 1 },
      firstFrameOffset: 0,
      lastFrameOffset: 2,
      traceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(summary)).not.toContain("private_action");
    expect(JSON.stringify(summary)).not.toContain("\"keycode\"");
    expect(summary).not.toHaveProperty("position");
  });

  it("summarizes recording controls with an empty canonical trace", () => {
    const input = InputOperationInputSchema.parse({ operation: "record_start", handle });
    expect(summarizeInputForAudit(input)).toMatchObject({
      handle,
      operation: "record_start",
      eventCount: 0,
      eventKinds: {},
      firstFrameOffset: null,
      lastFrameOffset: null,
      traceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
});
