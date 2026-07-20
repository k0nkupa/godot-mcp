import { join } from "node:path";

import type { ScenarioDeclaration, ScenarioReport } from "@godot-mcp/protocol";
import {
  copyFixture,
  launchEditor,
  launchMcpClient,
  reserveLoopbackPort,
  runCli,
  runGodot,
  waitUntil,
} from "@godot-mcp/testkit";
import { expect, test } from "vitest";

const pins = { width: 320, height: 180, renderer: "gl_compatibility" as const, locale: "en", seed: 42, fixedFps: 60 as const };

test.skipIf(process.platform !== "darwin")(
  "Phase 8 runs a visual job and baseline comparison through published stdio",
  async () => {
    const project = await copyFixture();
    const previousRuntime = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = join(project.root, "runtime");
    let editor: Awaited<ReturnType<typeof launchEditor>> | undefined;
    let client: Awaited<ReturnType<typeof launchMcpClient>> | undefined;
    try {
      expect((await runGodot(["--headless", "--editor", "--path", project.root, "--import"])).exitCode).toBe(0);
      expect((await runCli(["init", "--project", project.root])).exitCode).toBe(0);
      const port = await reserveLoopbackPort();
      editor = await launchEditor(project.root, { headless: false, debugServerPort: port, dapPort: port });
      client = await launchMcpClient([
        "connect", "--project", project.root,
        "--grant", "runtime_control",
        "--pack", "runtime",
        "--pack", "input",
        "--pack", "visual",
      ]);
      await waitUntil(async () => {
        const result = await client?.callTool({ name: "godot_session", arguments: {} });
        return (result?.structuredContent as { data?: { state?: string } } | undefined)?.data?.state === "attached";
      }, 15_000, 100);
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        "godot_capabilities", "godot_capture", "godot_doctor", "godot_help", "godot_input",
        "godot_query", "godot_runtime", "godot_runtime_capture", "godot_session", "godot_visual",
      ]);

      const capture = await runScenario(client, declaration("stdio-capture", [
        { kind: "capture", label: "frame", maxWidth: 320, maxHeight: 180, frameCount: 1, intervalFrames: 1, advancePaused: false },
      ]));
      expect(capture).toMatchObject({ state: "completed", cleanup: "succeeded" });
      const observationUri = capture.steps[0]?.evidence[0];
      const baseline = await callVisual(client, { operation: "baseline_create", name: "stdio-stable", observationUri });
      expect(baseline).toMatchObject({ name: "stdio-stable", width: 320, height: 180 });
      await expect(callVisual(client, { operation: "baseline_get", name: "stdio-stable" })).resolves.toMatchObject({ name: "stdio-stable" });

      const compared = await runScenario(client, declaration("stdio-compare", [
        { kind: "capture", label: "frame", maxWidth: 320, maxHeight: 180, frameCount: 1, intervalFrames: 1, advancePaused: false },
        {
          kind: "compare", captureLabel: "frame", frameIndex: 0, baselineName: "stdio-stable",
          settings: { masks: [{ x: 148, y: 84, width: 12, height: 12 }], maxChannelDelta: 0, maxDifferentPixels: 0, maxDifferentRatioMillionths: 0 },
        },
      ]));
      expect(compared).toMatchObject({ state: "completed", failedStepIndex: null, cleanup: "succeeded" });
    } finally {
      await client?.close();
      await editor?.close();
      if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previousRuntime;
      await project.cleanup();
    }
  },
  120_000,
);

function declaration(name: string, steps: ScenarioDeclaration["steps"]): ScenarioDeclaration {
  return { name, scenePath: "res://visual/visual_fixture.tscn", startupTimeoutMs: 15_000, deadlineMs: 60_000, pins, steps };
}

async function callVisual(
  client: NonNullable<Awaited<ReturnType<typeof launchMcpClient>>>,
  argumentsValue: Record<string, unknown>,
): Promise<unknown> {
  const result = await client.callTool({ name: "godot_visual", arguments: argumentsValue });
  const structured = result.structuredContent as { ok?: boolean; data?: unknown; error?: unknown } | undefined;
  expect(structured, JSON.stringify(structured)).toMatchObject({ ok: true });
  return structured?.data;
}

async function runScenario(
  client: NonNullable<Awaited<ReturnType<typeof launchMcpClient>>>,
  scenario: ScenarioDeclaration,
): Promise<ScenarioReport> {
  const started = await callVisual(client, { operation: "scenario_start", scenario }) as { jobToken: string };
  await waitUntil(async () => {
    const status = await callVisual(client, { operation: "scenario_status", jobToken: started.jobToken }) as { state: string };
    return ["completed", "failed", "cancelled"].includes(status.state);
  }, 90_000, 100);
  return await callVisual(client, { operation: "scenario_result", jobToken: started.jobToken }) as ScenarioReport;
}
