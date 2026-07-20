import { describe, expect, it } from "vitest";

import { ProjectOperationInputSchema, ProjectOperationResultSchema } from "./projectOperations.js";

const idempotencyKey = "019f75d0-1234-7abc-8def-0123456789ab";
const jobToken = `pjob_${"A".repeat(43)}`;

describe("project operation contracts", () => {
  it.each([
    { operation: "settings_apply", idempotencyKey, changes: [{ name: "display/window/size/viewport_width", expectedValue: 640, value: 1280 }] },
    { operation: "plugin_set", idempotencyKey, pluginPath: "res://addons/example/plugin.cfg", expectedEnabled: false, enabled: true },
    { operation: "import_start", kind: "full", deadlineMs: 120_000 },
    { operation: "import_start", kind: "reimport", resourcePaths: ["res://icon.svg"], deadlineMs: 120_000 },
    { operation: "run_start", scenePath: "res://scenes/main.tscn", headless: true, deadlineMs: 120_000 },
    { operation: "build_start", kind: "solutions", deadlineMs: 120_000 },
    { operation: "export_start", preset: "macOS", mode: "release", artifactName: "fixture-release", deadlineMs: 300_000 },
    { operation: "job_status", jobToken },
    { operation: "job_cancel", jobToken },
    { operation: "job_result", jobToken },
  ])("parses bounded operation %#", (input) => {
    expect(ProjectOperationInputSchema.parse(input)).toMatchObject(input);
  });

  it.each([
    { operation: "settings_apply", idempotencyKey, changes: [{ name: "editor_plugins/enabled", value: true }] },
    { operation: "settings_apply", idempotencyKey, changes: [{ name: "autoload/Backdoor", value: "res://evil.gd" }] },
    { operation: "settings_apply", idempotencyKey, changes: [{ name: "network/host", value: "https://example.com" }] },
    { operation: "plugin_set", idempotencyKey, pluginPath: "res://addons/godot_mcp/plugin.cfg", enabled: false, expectedEnabled: true },
    { operation: "plugin_set", idempotencyKey, pluginPath: "res://../escape/plugin.cfg", enabled: true, expectedEnabled: false },
    { operation: "import_start", kind: "reimport", resourcePaths: [] },
    { operation: "import_start", kind: "full", resourcePaths: ["res://icon.svg"] },
    { operation: "run_start", scenePath: "res://../escape.tscn" },
    { operation: "export_start", preset: "../escape", mode: "release", artifactName: "safe" },
    { operation: "job_status", jobToken: "pjob_forged" },
    { operation: "build_start", kind: "shell", command: "make" },
  ])("rejects hostile operation %#", (input) => {
    expect(() => ProjectOperationInputSchema.parse(input)).toThrow();
  });

  it("bounds mutation and reimport batches", () => {
    expect(() => ProjectOperationInputSchema.parse({
      operation: "settings_apply", idempotencyKey,
      changes: Array.from({ length: 33 }, (_, index) => ({ name: `display/window/test_${index}`, value: index })),
    })).toThrow();
    expect(() => ProjectOperationInputSchema.parse({
      operation: "import_start", kind: "reimport",
      resourcePaths: Array.from({ length: 129 }, (_, index) => `res://assets/${index}.png`),
    })).toThrow();
  });

  it("parses terminal results without host paths", () => {
    const result = ProjectOperationResultSchema.parse({
      jobToken,
      operation: "export",
      state: "completed",
      phase: "terminal",
      progressMillionths: 1_000_000,
      cancellationSafe: true,
      exitCode: 0,
      partialEffects: false,
      rollback: "not_needed",
      evidence: [`godot-mcp://evidence/${"a".repeat(64)}/observations/019f75d0-1234-7abc-8def-0123456789ab`],
      artifact: {
        uri: `godot-mcp://artifact/${jobToken}/${"b".repeat(64)}`,
        name: "fixture-release",
        byteLength: 123,
        sha256: "b".repeat(64),
        entryCount: 1,
        leakFree: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("/private/");
  });
});
