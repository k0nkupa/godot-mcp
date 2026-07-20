import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { ScenarioDeclaration, ScenarioReport } from "@godot-mcp/protocol";
import { inspectPng, launchEditor, launchMcpClient, reserveLoopbackPort, runCli, runGodot, waitUntil } from "@godot-mcp/testkit";
import { expect, test } from "vitest";

const source = "/Users/tony/Projects/town-building-game";
const sourcePresent = await access(join(source, "project.godot")).then(() => true, () => false);
const expectedSourceHead = "20482b130f8083bd381b3fd9dff2e0129b06a52f";
const baselineName = "town-smoke-approved";
const baselineBundle = join(process.cwd(), "tests/acceptance/baselines/town-building-game-phase-8");
const developedSaveFixture = join(process.cwd(), "tests/acceptance/fixtures/town-developed-save.gd");
const pins = { width: 1280, height: 720, renderer: "gl_compatibility" as const, locale: "en", seed: 42, fixedFps: 60 as const };
const readiness = { kind: "wait" as const, timeoutMs: 30_000, condition: { type: "frames_elapsed" as const, frames: 30 } };
const comparisonSettings = { masks: [], maxChannelDelta: 4, maxDifferentPixels: 9_216, maxDifferentRatioMillionths: 10_000 };
const updateBaseline = process.env.GODOT_MCP_UPDATE_TOWN_BASELINE === "1";

interface ApprovedTownBaseline {
  approval: {
    schemaVersion: 1;
    sourceHead: string;
    baselineName: string;
    pins: typeof pins;
    readiness: typeof readiness;
    comparisonSettings: typeof comparisonSettings;
  };
  manifest: {
    schemaVersion: 1;
    comparisonContractVersion: 1;
    name: string;
    sha256: string;
    mimeType: "image/png";
    byteLength: number;
    width: number;
    height: number;
    sourceObservationSha256: string;
    createdAtUnixMs: number;
  };
  png: Buffer;
}

test.skipIf(!sourcePresent)("accepts a town-building-game archive without changing its source checkout", async () => {
  const before = await sourceState();
  if (!updateBaseline) {
    expect(before.head, "town-building-game HEAD changed; regenerate and review the Phase 8 baseline").toBe(expectedSourceHead);
  }
  const approved = updateBaseline ? undefined : await readApprovedBaseline();
  const container = await mkdtemp("/private/tmp/godot-mcp-phase8-town-");
  const project = join(container, "project");
  const customUserDataName = basename(container);
  if (!customUserDataName.startsWith("godot-mcp-phase8-town-")) {
    throw new Error("Refusing an unexpected custom user-data name");
  }
  const userDataDirectory = join(homedir(), "Library", "Application Support", customUserDataName);
  const previousRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = join(container, "runtime");
  let editor: Awaited<ReturnType<typeof launchEditor>> | undefined;
  let client: Awaited<ReturnType<typeof launchMcpClient>> | undefined;
  try {
    await mkdir(project, { recursive: true });
    await extractHeadArchive(project);
    await configureCustomUserData(project, customUserDataName);
    const imported = await runGodot(
      ["--headless", "--editor", "--path", project, "--import"],
      { timeoutMs: 300_000 },
    );
    expect(imported.exitCode, imported.stderr).toBe(0);
    await seedDevelopedSave(project, userDataDirectory);
    const initialized = await runCli(["init", "--project", project]);
    expect(initialized.exitCode, initialized.stderr).toBe(0);
    if (approved) await stageApprovedBaseline(project, approved);
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

    const steps: ScenarioDeclaration["steps"] = [
      readiness,
      { kind: "assert", assertion: { type: "no_error_logs" } },
      { kind: "control", action: "pause" },
      { kind: "capture", label: "town", maxWidth: 1280, maxHeight: 720, frameCount: 1, intervalFrames: 1, advancePaused: true },
      ...(!updateBaseline ? [{
        kind: "compare" as const,
        captureLabel: "town",
        frameIndex: 0,
        baselineName,
        settings: comparisonSettings,
      }] : []),
    ];
    const report = await runScenario(client, townScenario("town-smoke-approved", steps));
    if (report.state !== "completed" && process.env.GODOT_MCP_FAILURE_ARTIFACT_DIR) {
      await cp(
        join(project, ".godot/evidence/godot-mcp"),
        join(process.env.GODOT_MCP_FAILURE_ARTIFACT_DIR, "town-building-game-phase-8-evidence"),
        { recursive: true, force: true },
      );
    }
    if (updateBaseline) {
      expect(report, JSON.stringify(report, null, 2)).toMatchObject({ state: "completed", cleanup: "succeeded" });
      const observationUri = report.steps.find((step) => step.kind === "capture")?.evidence[0];
      expect(observationUri).toBeTypeOf("string");
      await callVisual(client, { operation: "baseline_create", name: baselineName, observationUri });
      const artifactRoot = process.env.GODOT_MCP_FAILURE_ARTIFACT_DIR;
      if (!artifactRoot) throw new Error("GODOT_MCP_FAILURE_ARTIFACT_DIR is required in baseline-update mode");
      const candidate = join(artifactRoot, "town-building-game-phase-8-candidate");
      await mkdir(candidate, { recursive: true });
      await cp(
        join(project, ".godot/evidence/godot-mcp/baselines", baselineName),
        join(candidate, "baseline"),
        { recursive: true, force: true },
      );
      await writeFile(join(candidate, "approval.json"), `${JSON.stringify({
        schemaVersion: 1,
        sourceHead: before.head,
        baselineName,
        pins,
        readiness,
        comparisonSettings,
      }, null, 2)}\n`, "utf8");
      throw new Error(`Baseline candidate written to ${candidate}; visual approval is required before commit`);
    }
    expect(report, JSON.stringify(report, null, 2)).toMatchObject({
      state: "completed",
      failedStepIndex: null,
      cleanup: "succeeded",
      steps: expect.arrayContaining([
        expect.objectContaining({ kind: "wait", state: "completed" }),
        expect.objectContaining({ kind: "capture", state: "completed" }),
        expect.objectContaining({ kind: "compare", state: "completed", summary: expect.objectContaining({ passed: true }) }),
      ]),
    });
  } finally {
    await client?.close();
    await editor?.close();
    if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntime;
    if (!container.startsWith("/private/tmp/godot-mcp-phase8-town-")) throw new Error("Refusing to remove an unexpected acceptance directory");
    await rm(container, { recursive: true, force: true });
    if (!basename(userDataDirectory).startsWith("godot-mcp-phase8-town-")) {
      throw new Error("Refusing to remove an unexpected Godot user-data directory");
    }
    await rm(userDataDirectory, { recursive: true, force: true });
    expect(await sourceState()).toEqual(before);
  }
}, 600_000);

async function configureCustomUserData(project: string, name: string): Promise<void> {
  if (!/^godot-mcp-phase8-town-[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error("Custom user-data name is outside the acceptance namespace");
  }
  const path = join(project, "project.godot");
  const settings = await readFile(path, "utf8");
  const header = "[application]\n";
  if (!settings.includes(header) || settings.includes("config/use_custom_user_dir")) {
    throw new Error("Disposable project application settings cannot be safely amended");
  }
  const isolated = settings.replace(
    header,
    `${header}\nconfig/use_custom_user_dir=true\nconfig/custom_user_dir_name="${name}"\n`,
  );
  await writeFile(path, isolated, "utf8");
}

async function seedDevelopedSave(project: string, userDataDirectory: string): Promise<void> {
  const fixtureDirectory = join(project, ".godot-mcp", "acceptance");
  const fixturePath = join(fixtureDirectory, "town-developed-save.gd");
  await mkdir(fixtureDirectory, { recursive: true });
  await cp(developedSaveFixture, fixturePath);
  try {
    const seeded = await runGodot(
      ["--headless", "--path", project, "--script", "res://.godot-mcp/acceptance/town-developed-save.gd"],
      { timeoutMs: 60_000 },
    );
    expect(seeded.exitCode, `${seeded.stdout}\n${seeded.stderr}`).toBe(0);
    expect(`${seeded.stdout}\n${seeded.stderr}`).toContain("GODOT_MCP_TOWN_SAVE_READY");
    await expect(access(join(userDataDirectory, "saves", "town.json"))).resolves.toBeUndefined();
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
}

async function readApprovedBaseline(): Promise<ApprovedTownBaseline> {
  const approval = JSON.parse(await readFile(join(baselineBundle, "approval.json"), "utf8")) as ApprovedTownBaseline["approval"];
  const manifest = JSON.parse(await readFile(join(baselineBundle, "baseline", "manifest.json"), "utf8")) as ApprovedTownBaseline["manifest"];
  expect(approval).toEqual({
    schemaVersion: 1,
    sourceHead: expectedSourceHead,
    baselineName,
    pins,
    readiness,
    comparisonSettings,
  });
  expect(manifest).toMatchObject({
    schemaVersion: 1,
    comparisonContractVersion: 1,
    name: baselineName,
    mimeType: "image/png",
    sourceObservationSha256: manifest.sha256,
  });
  expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(manifest.byteLength).toBeGreaterThan(0);
  expect(manifest.createdAtUnixMs).toBeGreaterThanOrEqual(0);
  const png = await readFile(join(baselineBundle, "baseline", "approved.png"));
  expect(createHash("sha256").update(png).digest("hex")).toBe(manifest.sha256);
  expect(png.byteLength).toBe(manifest.byteLength);
  expect(inspectPng(png)).toMatchObject({ width: manifest.width, height: manifest.height });
  return { approval, manifest, png };
}

async function stageApprovedBaseline(project: string, approved: ApprovedTownBaseline): Promise<void> {
  const destination = join(project, ".godot/evidence/godot-mcp/baselines", approved.manifest.name);
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, "manifest.json"), `${JSON.stringify(approved.manifest)}\n`, "utf8");
  await writeFile(join(destination, `${approved.manifest.sha256}.png`), approved.png);
}

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
