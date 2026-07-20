import { rm, symlink } from "node:fs/promises";
import { join } from "node:path";

import { authorize, EvidenceStore, VISUAL_POLICY } from "@godot-mcp/control-plane";
import { ScenarioDeclarationSchema, VisualOperationInputSchema } from "@godot-mcp/protocol";
import { copyFixture, createRgbaPng } from "@godot-mcp/testkit";
import { describe, expect, it } from "vitest";

const pins = { width: 320, height: 180, renderer: "gl_compatibility", locale: "en", seed: 42, fixedFps: 60 };

describe("hostile visual QA boundaries", () => {
  it("rejects traversal, malformed evidence identities, oversized jobs, and forward references", () => {
    expect(() => VisualOperationInputSchema.parse({ operation: "baseline_get", name: "../escape" })).toThrow();
    expect(() => VisualOperationInputSchema.parse({ operation: "baseline_create", name: "safe", observationUri: "file:///tmp/frame.png" })).toThrow();
    expect(() => ScenarioDeclarationSchema.parse({
      name: "oversized",
      scenePath: "res://visual/visual_fixture.tscn",
      pins,
      steps: Array.from({ length: 65 }, () => ({ kind: "control", action: "pause" })),
    })).toThrow();
    expect(() => ScenarioDeclarationSchema.parse({
      name: "forward-reference",
      scenePath: "res://visual/visual_fixture.tscn",
      pins,
      steps: [{
        kind: "compare",
        captureLabel: "later",
        frameIndex: 0,
        baselineName: "safe",
        settings: { masks: [], maxChannelDelta: 0, maxDifferentPixels: 0, maxDifferentRatioMillionths: 0 },
      }, { kind: "capture", label: "later" }],
    })).toThrow();
  });

  it("requires runtime_control and every visual prerequisite pack", () => {
    expect(() => authorize({ tiers: ["observe"], packs: ["core", "runtime", "input", "visual"] }, VISUAL_POLICY)).toThrow();
    expect(() => authorize({ tiers: ["observe", "runtime_control"], packs: ["core", "runtime", "visual"] }, VISUAL_POLICY)).toThrow();
    expect(() => authorize({ tiers: ["observe", "runtime_control"], packs: ["core", "runtime", "input", "visual"] }, VISUAL_POLICY)).not.toThrow();
  });

  it("rejects cross-session observations, malformed PNGs, and symlinked baselines", async () => {
    const project = await copyFixture();
    try {
      const store = new EvidenceStore(project.root);
      const png = createRgbaPng(2, 2, () => [0, 0, 0, 255]);
      const stored = await store.putPng("session_12345678", png, { viewport: "runtime", width: 2, height: 2 });
      await expect(store.readSessionPngObservation("session_other123", stored.observationUri)).rejects.toMatchObject({ code: "STALE_HANDLE" });
      await expect(store.putPng("session_12345678", new Uint8Array([1, 2, 3]), { viewport: "runtime", width: 1, height: 1 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });

      await store.createPngBaseline("session_12345678", "safe", stored.observationUri, 1);
      const manifest = join(project.root, ".godot/evidence/godot-mcp/baselines/safe/manifest.json");
      await rm(manifest);
      await symlink(join(project.root, "project.godot"), manifest);
      await expect(store.readPngBaseline("safe")).rejects.toMatchObject({ code: "PATH_DENIED" });
    } finally {
      await project.cleanup();
    }
  });
});
