import { createRgbaPng, copyFixture } from "@godot-mcp/testkit";
import { describe, expect, it } from "vitest";

import { EvidenceStore } from "../evidence/evidenceStore.js";
import { VisualService } from "./visualService.js";

const black = createRgbaPng(2, 2, () => [0, 0, 0, 255]);
const changed = createRgbaPng(2, 2, (x, y) => x === 0 && y === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255]);

describe("VisualService", () => {
  it("creates and reads immutable baselines, then stores comparison evidence", async () => {
    const project = await copyFixture();
    try {
      const evidence = new EvidenceStore(project.root);
      const baselineObservation = await evidence.putPng("session_12345678", black, { viewport: "runtime", width: 2, height: 2 });
      const changedObservation = await evidence.putPng("session_12345678", changed, { viewport: "runtime", width: 2, height: 2 });
      const scenario = {
        start: () => { throw new Error("unused"); },
        status: () => { throw new Error("unused"); },
        cancel: () => { throw new Error("unused"); },
        result: () => { throw new Error("unused"); },
      };
      const service = new VisualService({ sessionId: () => "session_12345678", evidence, scenario });

      await expect(service.execute({ operation: "baseline_create", name: "ready", observationUri: baselineObservation.observationUri }))
        .resolves.toMatchObject({ data: { name: "ready", sha256: baselineObservation.sha256 } });
      await expect(service.execute({ operation: "baseline_get", name: "ready" }))
        .resolves.toMatchObject({ data: { name: "ready", sha256: baselineObservation.sha256 } });
      const compared = await service.execute({
        operation: "compare",
        name: "ready",
        observationUri: changedObservation.observationUri,
        settings: { masks: [], maxChannelDelta: 0, maxDifferentPixels: 0, maxDifferentRatioMillionths: 0 },
      });
      expect(compared).toMatchObject({ data: { passed: false, differentPixels: 1 }, evidence: expect.arrayContaining([changedObservation.observationUri]) });
      expect(compared.images).toHaveLength(1);
      expect(JSON.stringify(compared.data)).not.toContain(project.root);
    } finally {
      await project.cleanup();
    }
  });

  it("dispatches only opaque scenario job operations", async () => {
    const project = await copyFixture();
    try {
      const calls: string[] = [];
      const reportUri = `godot-mcp://evidence/${"a".repeat(64)}/observations/019f644c-1379-79c0-825e-66a4b7653bd1` as const;
      const scenario = {
        start: () => { calls.push("start"); return { jobToken: `vsj_${"A".repeat(43)}`, state: "queued" as const, completedSteps: 0, totalSteps: 1 }; },
        status: () => { calls.push("status"); return { jobToken: `vsj_${"A".repeat(43)}`, state: "running" as const, completedSteps: 0, totalSteps: 1 }; },
        cancel: () => { calls.push("cancel"); return { jobToken: `vsj_${"A".repeat(43)}`, state: "cancelled" as const, completedSteps: 0, totalSteps: 1 }; },
        result: () => { calls.push("result"); return { reportObservationUri: reportUri }; },
      };
      const service = new VisualService({ sessionId: () => "session_12345678", evidence: new EvidenceStore(project.root), scenario });
      const declaration = {
        name: "smoke",
        scenePath: "res://visual/visual_fixture.tscn",
        startupTimeoutMs: 1_000,
        deadlineMs: 5_000,
        pins: { width: 320, height: 180, renderer: "gl_compatibility" as const, locale: "en_NZ", seed: 42, fixedFps: 60 as const },
        steps: [{ kind: "control" as const, action: "pause" as const }],
      };
      const token = `vsj_${"A".repeat(43)}`;

      await service.execute({ operation: "scenario_start", scenario: declaration });
      await service.execute({ operation: "scenario_status", jobToken: token });
      await service.execute({ operation: "scenario_cancel", jobToken: token });
      await expect(service.execute({ operation: "scenario_result", jobToken: token }))
        .resolves.toMatchObject({ evidence: [reportUri] });
      expect(calls).toEqual(["start", "status", "cancel", "result"]);
    } finally {
      await project.cleanup();
    }
  });
});
