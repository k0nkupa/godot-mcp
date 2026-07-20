import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { ScenarioDeclaration, ScenarioReport } from "@godot-mcp/protocol";
import { launchEditor, launchMcpClient, reserveLoopbackPort, runCli, runGodot, waitUntil } from "@godot-mcp/testkit";
import { expect, test } from "vitest";

const source = "/Users/tony/Projects/town-building-game";
const sourcePresent = await access(join(source, "project.godot")).then(() => true, () => false);
const pins = { width: 1280, height: 720, renderer: "gl_compatibility" as const, locale: "en", seed: 42, fixedFps: 60 as const };

test.skipIf(!sourcePresent)("accepts a town-building-game archive without changing its source checkout", async () => {
  const before = await sourceState();
  const container = await mkdtemp("/private/tmp/godot-mcp-phase8-town-");
  const project = join(container, "project");
  const previousRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = join(container, "runtime");
  let editor: Awaited<ReturnType<typeof launchEditor>> | undefined;
  let client: Awaited<ReturnType<typeof launchMcpClient>> | undefined;
  try {
    await mkdir(project, { recursive: true });
    await extractHeadArchive(project);
    const imported = await runGodot(["--headless", "--editor", "--path", project, "--import"]);
    expect(imported.exitCode, imported.stderr).toBe(0);
    expect((await runCli(["init", "--project", project])).exitCode).toBe(0);
    const port = await reserveLoopbackPort();
    editor = await launchEditor(project, { headless: false, debugServerPort: port, dapPort: port });
    client = await launchMcpClient([
      "connect", "--project", project,
      "--grant", "runtime_control",
      "--pack", "runtime", "--pack", "input", "--pack", "visual",
    ]);
    await waitUntil(async () => {
      const result = await client?.callTool({ name: "godot_session", arguments: {} });
      return (result?.structuredContent as { data?: { state?: string } } | undefined)?.data?.state === "attached";
    }, 20_000, 100);

    const first = await runScenario(client, townScenario("town-smoke-source", [
      { kind: "control", action: "pause" },
      { kind: "capture", label: "town", maxWidth: 1280, maxHeight: 720, frameCount: 1, intervalFrames: 1, advancePaused: true },
    ]));
    expect(first).toMatchObject({ state: "completed", cleanup: "succeeded" });
    const observationUri = first.steps[1]?.evidence[0];
    await callVisual(client, { operation: "baseline_create", name: "town-smoke", observationUri });

    const second = await runScenario(client, townScenario("town-smoke-repeat", [
      { kind: "control", action: "pause" },
      { kind: "capture", label: "town", maxWidth: 1280, maxHeight: 720, frameCount: 1, intervalFrames: 1, advancePaused: true },
      {
        kind: "compare", captureLabel: "town", frameIndex: 0, baselineName: "town-smoke",
        settings: { masks: [], maxChannelDelta: 4, maxDifferentPixels: 9_216, maxDifferentRatioMillionths: 10_000 },
      },
    ]));
    expect(second).toMatchObject({ state: "completed", failedStepIndex: null, cleanup: "succeeded" });
  } finally {
    await client?.close();
    await editor?.close();
    if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntime;
    if (!container.startsWith("/private/tmp/godot-mcp-phase8-town-")) throw new Error("Refusing to remove an unexpected acceptance directory");
    await rm(container, { recursive: true, force: true });
    expect(await sourceState()).toEqual(before);
  }
}, 180_000);

function townScenario(name: string, steps: ScenarioDeclaration["steps"]): ScenarioDeclaration {
  return { name, scenePath: "res://scenes/main.tscn", startupTimeoutMs: 30_000, deadlineMs: 120_000, pins, steps };
}

async function sourceState(): Promise<{ head: string; statusSha256: string; indexSha256: string }> {
  const head = (await collect("git", ["rev-parse", "HEAD"], source)).toString("utf8").trim();
  const status = await collect("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], source);
  const index = await collect("git", ["ls-files", "-s", "-z"], source);
  return {
    head,
    statusSha256: createHash("sha256").update(status).digest("hex"),
    indexSha256: createHash("sha256").update(index).digest("hex"),
  };
}

async function extractHeadArchive(destination: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const archive = spawn("git", ["archive", "HEAD"], { cwd: source, stdio: ["ignore", "pipe", "pipe"] });
    const tar = spawn("tar", ["-x", "-C", destination], { stdio: ["pipe", "ignore", "pipe"] });
    let errors = "";
    archive.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    tar.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    archive.stdout.pipe(tar.stdin);
    let archiveCode: number | null | undefined;
    let tarCode: number | null | undefined;
    const finish = () => {
      if (archiveCode === undefined || tarCode === undefined) return;
      if (archiveCode === 0 && tarCode === 0) resolvePromise();
      else reject(new Error(`Could not materialize town archive: ${errors}`));
    };
    archive.once("error", reject); tar.once("error", reject);
    archive.once("close", (code) => { archiveCode = code; finish(); });
    tar.once("close", (code) => { tarCode = code; finish(); });
  });
}

async function collect(command: string, args: string[], cwd: string): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const output: Buffer[] = [];
    let error = "";
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolvePromise(Buffer.concat(output)) : reject(new Error(error)));
  });
}

async function callVisual(client: NonNullable<Awaited<ReturnType<typeof launchMcpClient>>>, argumentsValue: Record<string, unknown>): Promise<unknown> {
  const result = await client.callTool({ name: "godot_visual", arguments: argumentsValue });
  const structured = result.structuredContent as { ok?: boolean; data?: unknown } | undefined;
  expect(structured, JSON.stringify(structured)).toMatchObject({ ok: true });
  return structured?.data;
}

async function runScenario(client: NonNullable<Awaited<ReturnType<typeof launchMcpClient>>>, scenario: ScenarioDeclaration): Promise<ScenarioReport> {
  const started = await callVisual(client, { operation: "scenario_start", scenario }) as { jobToken: string };
  await waitUntil(async () => {
    const status = await callVisual(client, { operation: "scenario_status", jobToken: started.jobToken }) as { state: string };
    return ["completed", "failed", "cancelled"].includes(status.state);
  }, 150_000, 100);
  return await callVisual(client, { operation: "scenario_result", jobToken: started.jobToken }) as ScenarioReport;
}
