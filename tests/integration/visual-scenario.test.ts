import type { ScenarioDeclaration } from "@godot-mcp/protocol";
import { expect, test } from "vitest";

import { createPhase8VisualFixture } from "./visual-phase8-fixture.js";

const pins = { width: 320, height: 180, renderer: "gl_compatibility" as const, locale: "en", seed: 42, fixedFps: 60 as const };
const settings = {
  masks: [{ x: 148, y: 84, width: 12, height: 12 }],
  maxChannelDelta: 0,
  maxDifferentPixels: 0,
  maxDifferentRatioMillionths: 0,
};

function scenario(name: string, steps: ScenarioDeclaration["steps"]): ScenarioDeclaration {
  return {
    name,
    scenePath: "res://visual/visual_fixture.tscn",
    startupTimeoutMs: 15_000,
    deadlineMs: 60_000,
    pins,
    steps,
  };
}

test("runs repeatable pinned visual scenarios and preserves failed-diff evidence", async () => {
  const fixture = await createPhase8VisualFixture();
  try {
    const source = await fixture.run(scenario("baseline-source", [
      { kind: "capture", label: "stable", maxWidth: 320, maxHeight: 180, frameCount: 1, intervalFrames: 1, advancePaused: false },
    ]));
    expect(source).toMatchObject({ state: "completed", observedPins: pins, cleanup: "succeeded" });
    const observationUri = source.steps[0]?.evidence[0];
    expect(observationUri).toMatch(/^godot-mcp:\/\/evidence\//);
    await fixture.visual.execute({ operation: "baseline_create", name: "visual-stable", observationUri: observationUri! });

    const exact = await fixture.run(scenario("exact-repeat", [
      { kind: "capture", label: "stable", maxWidth: 320, maxHeight: 180, frameCount: 1, intervalFrames: 1, advancePaused: false },
      { kind: "compare", captureLabel: "stable", frameIndex: 0, baselineName: "visual-stable", settings },
    ]));
    expect(exact).toMatchObject({ state: "completed", failedStepIndex: null, cleanup: "succeeded" });

    const changed = await fixture.run(scenario("intentional-delta", [
      { kind: "control", action: "pause" },
      { kind: "input", mode: "deterministic", timeoutMs: 10_000, trace: { schemaVersion: 1, events: [{ frameOffset: 0, event: { type: "action", action: "ui_accept", pressed: true, strengthMillionths: 1_000_000 } }] } },
      { kind: "capture", label: "changed", maxWidth: 320, maxHeight: 180, frameCount: 1, intervalFrames: 1, advancePaused: true },
      { kind: "compare", captureLabel: "changed", frameIndex: 0, baselineName: "visual-stable", settings },
    ]));
    expect(changed).toMatchObject({ state: "failed", failedStepIndex: 3, cleanup: "succeeded" });
    expect(changed.steps[3]?.evidence.length).toBeGreaterThanOrEqual(3);
  } catch (error) {
    throw new Error(`${String(error)}\n${fixture.diagnostics()}`);
  } finally {
    await fixture.close();
  }
}, 120_000);
