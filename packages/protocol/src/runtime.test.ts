import { describe, expect, it } from "vitest";

import {
  RuntimeCaptureInputSchema,
  RuntimeHandleSchema,
  RuntimeOperationInputSchema,
} from "./runtime.js";

const handle = { runId: "019f644c-1379-79c0-825e-66a4b7653bd1", generation: 1 };

describe("Phase 3 runtime schemas", () => {
  it("accepts the closed runtime operation surface", () => {
    expect(RuntimeOperationInputSchema.parse({ operation: "launch", scenePath: "res://runtime/main.tscn" })).toMatchObject({ operation: "launch", startupTimeoutMs: 15_000 });
    expect(RuntimeOperationInputSchema.parse({ operation: "status" })).toEqual({ operation: "status" });
    expect(RuntimeOperationInputSchema.parse({ operation: "tree", handle })).toMatchObject({ operation: "tree", root: ".", maxDepth: 12, maxNodes: 500 });
    expect(RuntimeOperationInputSchema.parse({ operation: "node", handle, nodePath: "Actors/Hero" })).toMatchObject({ includeProperties: true, includeSignals: true });
    expect(RuntimeOperationInputSchema.parse({ operation: "logs", handle })).toMatchObject({ afterSequence: 0, limit: 100 });
    expect(RuntimeOperationInputSchema.parse({ operation: "wait", handle, timeoutMs: 5_000, condition: { type: "node_exists", nodePath: "Ready" } }).operation).toBe("wait");
    for (const operation of ["pause", "resume", "stop"] as const) {
      expect(RuntimeOperationInputSchema.parse({ operation, handle }).operation).toBe(operation);
    }
    expect(RuntimeOperationInputSchema.parse({ operation: "step", handle, frames: 120 })).toMatchObject({ operation: "step", frames: 120 });
  });

  it("rejects paths and bounds outside Phase 3", () => {
    expect(() => RuntimeOperationInputSchema.parse({ operation: "launch", scenePath: "/tmp/main.tscn" })).toThrow();
    expect(() => RuntimeOperationInputSchema.parse({ operation: "launch", scenePath: "res://../main.tscn" })).toThrow();
    expect(() => RuntimeOperationInputSchema.parse({ operation: "node", handle, nodePath: "/root/Main" })).toThrow();
    expect(() => RuntimeOperationInputSchema.parse({ operation: "node", handle, nodePath: "Hero:secret" })).toThrow();
    expect(() => RuntimeOperationInputSchema.parse({ operation: "step", handle, frames: 121 })).toThrow();
    expect(() => RuntimeOperationInputSchema.parse({ operation: "wait", handle, timeoutMs: 30_001, condition: { type: "frames_elapsed", frames: 1 } })).toThrow();
    expect(() => RuntimeCaptureInputSchema.parse({ handle, frameCount: 9 })).toThrow();
  });

  it("defaults bounded capture and validates handles", () => {
    expect(RuntimeCaptureInputSchema.parse({ handle })).toEqual({
      handle,
      maxWidth: 1280,
      maxHeight: 720,
      frameCount: 1,
      intervalFrames: 1,
      advancePaused: false,
    });
    expect(() => RuntimeHandleSchema.parse({ ...handle, generation: 0 })).toThrow();
  });
});
