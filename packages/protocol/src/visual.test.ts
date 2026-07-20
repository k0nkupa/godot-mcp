import { describe, expect, it } from "vitest";

import {
  RuntimeLaunchPinsSchema,
  ScenarioDeclarationSchema,
  VisualOperationInputSchema,
} from "./visual.js";

const observationUri = `godot-mcp://evidence/${"a".repeat(64)}/observations/019f644c-1379-79c0-825e-66a4b7653bd1`;
const pins = {
  width: 320,
  height: 180,
  renderer: "gl_compatibility" as const,
  locale: "en_NZ",
  seed: 42,
  fixedFps: 60 as const,
};

function scenario() {
  return {
    name: "visual-smoke",
    scenePath: "res://visual/visual_fixture.tscn",
    startupTimeoutMs: 15_000,
    deadlineMs: 60_000,
    pins,
    steps: [
      { kind: "wait", timeoutMs: 1_000, condition: { type: "node_exists", nodePath: "State" } },
      { kind: "assert", assertion: { type: "property_equals", nodePath: "State", property: "mode", value: "ready" } },
      { kind: "control", action: "pause" },
      {
        kind: "input",
        mode: "deterministic",
        timeoutMs: 1_000,
        trace: {
          schemaVersion: 1,
          events: [{ frameOffset: 0, event: { type: "action", action: "ui_accept", pressed: true } }],
        },
      },
      { kind: "capture", label: "after-input", maxWidth: 320, maxHeight: 180, frameCount: 1, intervalFrames: 1, advancePaused: true },
      {
        kind: "compare",
        captureLabel: "after-input",
        frameIndex: 0,
        baselineName: "fixture-ready",
        settings: {
          region: { x: 0, y: 0, width: 320, height: 180 },
          masks: [{ x: 280, y: 0, width: 12, height: 12 }],
          maxChannelDelta: 0,
          maxDifferentPixels: 0,
          maxDifferentRatioMillionths: 0,
        },
      },
      { kind: "assert", assertion: { type: "no_error_logs" } },
    ],
  };
}

describe("Phase 8 visual contracts", () => {
  it("parses a complete bounded scenario and applies defaults", () => {
    const parsed = ScenarioDeclarationSchema.parse(scenario());

    expect(parsed).toMatchObject({ name: "visual-smoke", pins });
    expect(parsed.steps[0]).toMatchObject({ kind: "wait" });
    expect(parsed.steps[3]).toMatchObject({ kind: "input", mode: "deterministic" });
  });

  it("accepts only fixed deterministic launch pins", () => {
    expect(RuntimeLaunchPinsSchema.parse(pins)).toEqual(pins);
    expect(() => RuntimeLaunchPinsSchema.parse({ ...pins, fixedFps: 59 })).toThrow();
    expect(() => RuntimeLaunchPinsSchema.parse({ ...pins, renderer: "forward_plus" })).toThrow();
    expect(() => RuntimeLaunchPinsSchema.parse({ ...pins, locale: "../../etc" })).toThrow();
    expect(() => RuntimeLaunchPinsSchema.parse({ ...pins, rawArguments: ["--script", "bad.gd"] })).toThrow();
  });

  it("rejects duplicate labels and forward capture references", () => {
    const duplicate = scenario();
    const duplicateSteps = duplicate.steps as Array<Record<string, unknown>>;
    duplicateSteps.splice(5, 0, { ...duplicateSteps[4]! });
    expect(() => ScenarioDeclarationSchema.parse(duplicate)).toThrow(/unique/i);

    const forward = scenario();
    const comparison = forward.steps.splice(5, 1)[0]!;
    forward.steps.splice(4, 0, comparison);
    expect(() => ScenarioDeclarationSchema.parse(forward)).toThrow(/earlier capture/i);
  });

  it("rejects hostile paths, unknown keys, excessive steps, and malformed evidence references", () => {
    expect(() => ScenarioDeclarationSchema.parse({ ...scenario(), scenePath: "res://../secret.tscn" })).toThrow();
    expect(() => ScenarioDeclarationSchema.parse({ ...scenario(), shell: "id" })).toThrow();
    expect(() => ScenarioDeclarationSchema.parse({ ...scenario(), steps: Array.from({ length: 65 }, () => scenario().steps[0]) })).toThrow();
    expect(() => VisualOperationInputSchema.parse({ operation: "baseline_create", name: "ready", observationUri: "file:///tmp/a.png" })).toThrow();
  });

  it("rejects invalid comparison geometry and tolerances", () => {
    const invalid = scenario();
    const invalidSteps = invalid.steps as Array<Record<string, unknown>>;
    invalidSteps[5] = {
      ...invalidSteps[5]!,
      settings: {
        region: { x: -1, y: 0, width: 0, height: 180 },
        masks: Array.from({ length: 65 }, () => ({ x: 0, y: 0, width: 1, height: 1 })),
        maxChannelDelta: 256,
        maxDifferentPixels: 4_194_305,
        maxDifferentRatioMillionths: 1_000_001,
      },
    };
    expect(() => ScenarioDeclarationSchema.parse(invalid)).toThrow();
  });

  it("rejects a scenario document over 512 KiB", () => {
    const oversized = scenario();
    oversized.steps = Array.from({ length: 64 }, () => ({
      kind: "input",
      mode: "realtime",
      timeoutMs: 1_000,
      trace: {
        schemaVersion: 1,
        events: Array.from({ length: 256 }, (_, frameOffset) => ({
          frameOffset,
          event: { type: "action", action: `action_${"x".repeat(120)}`, pressed: true },
        })),
      },
    }));
    expect(() => ScenarioDeclarationSchema.parse(oversized)).toThrow(/512 KiB/i);
  });

  it.each([
    { operation: "baseline_create", name: "ready", observationUri },
    { operation: "baseline_get", name: "ready" },
    { operation: "compare", name: "ready", observationUri, settings: { maxChannelDelta: 0, maxDifferentPixels: 0, maxDifferentRatioMillionths: 0 } },
    { operation: "scenario_start", scenario: scenario() },
    { operation: "scenario_status", jobToken: `vsj_${"A".repeat(43)}` },
    { operation: "scenario_cancel", jobToken: `vsj_${"A".repeat(43)}` },
    { operation: "scenario_result", jobToken: `vsj_${"A".repeat(43)}` },
  ])("parses the $operation operation", (operation) => {
    expect(VisualOperationInputSchema.parse(operation)).toMatchObject(operation);
  });
});
