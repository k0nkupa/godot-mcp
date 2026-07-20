import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { startBridgeServer } from "@godot-mcp/bridge-client";
import { createSecureEditorLaunchAttestation, installAddon, secureEditorArguments } from "@godot-mcp/cli";
import {
  EvidenceStore,
  JsonlAuditSink,
  OwnedGodotProcess,
  readProjectIdentity,
  RuntimeService,
  ScenarioService,
  VisualService,
} from "@godot-mcp/control-plane";
import type { RuntimeCaptureFrameMetadata, ScenarioDeclaration, ScenarioReport } from "@godot-mcp/protocol";
import { copyFixture, findGodotBinary, reserveLoopbackPort, runGodot } from "@godot-mcp/testkit";

export interface Phase8VisualFixture {
  projectRoot: string;
  visual: VisualService;
  run(declaration: ScenarioDeclaration): Promise<ScenarioReport>;
  diagnostics(): string;
  close(): Promise<void>;
}

export async function createPhase8VisualFixture(): Promise<Phase8VisualFixture> {
  const project = await copyFixture();
  const previousRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
  const previousDataDirectory = process.env.XDG_DATA_HOME;
  const dataDirectory = await mkdtemp("/private/tmp/godot-mcp-phase8-xdg.");
  process.env.XDG_RUNTIME_DIR = join(project.root, "runtime-dir");
  process.env.XDG_DATA_HOME = dataDirectory;
  let editor: ReturnType<typeof spawn> | undefined;
  let attestation: Awaited<ReturnType<typeof createSecureEditorLaunchAttestation>> | undefined;
  let bridge: Awaited<ReturnType<typeof startBridgeServer>> | undefined;
  let runtime: RuntimeService | undefined;
  let scenarios: ScenarioService | undefined;
  let editorOutput = "";
  let runtimeOutput = "";
  try {
    const imported = await runGodot(["--headless", "--editor", "--path", project.root, "--import", "--log-file", join(dataDirectory, "import.log")]);
    if (imported.exitCode !== 0) throw new Error(`Fixture import failed: ${imported.stderr}`);
    await installAddon(project.root, resolve(process.cwd(), "addons/godot_mcp"));
    const projectFile = join(project.root, "project.godot");
    const projectSettings = await readFile(projectFile, "utf8");
    await writeFile(projectFile, `${projectSettings.trimEnd()}\n\n[editor_plugins]\n\nenabled=PackedStringArray("res://addons/godot_mcp/plugin.cfg")\n`, "utf8");
    await project.snapshot();
    const identity = await readProjectIdentity(project.root);
    const manifest = JSON.parse(await readFile(join(project.root, ".godot/godot-mcp/install-manifest.json"), "utf8")) as { manifestSha256: string };
    bridge = await startBridgeServer({
      project: identity,
      grants: { tiers: ["observe", "runtime_control"], packs: ["core", "runtime", "input", "visual"] },
      addonManifestSha256: manifest.manifestSha256,
      auditSink: new JsonlAuditSink(join(dirname(project.root), "visual-phase8-audit.jsonl")),
    });
    const port = await reserveLoopbackPort();
    attestation = await createSecureEditorLaunchAttestation(identity.projectId, port);
    editor = spawn(await findGodotBinary(), [
      "--headless",
      "--log-file", join(dataDirectory, "editor.log"),
      ...secureEditorArguments(project.root, port, attestation.path),
    ], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    editor.stdout?.on("data", (chunk: Buffer) => { editorOutput += chunk.toString(); });
    editor.stderr?.on("data", (chunk: Buffer) => { editorOutput += chunk.toString(); });
    const session = await bridge.waitForAttachment(15_000);
    runtime = new RuntimeService({
      project: identity,
      sessionId: () => session.sessionId,
      godotBin: await findGodotBinary(),
      launchProcess: async (input) => {
        const owned = await OwnedGodotProcess.launch(input);
        const diagnostics = owned.diagnostics.bind(owned);
        const stop = owned.stop.bind(owned);
        return {
          pid: owned.pid,
          fingerprint: owned.fingerprint,
          wait: owned.wait.bind(owned),
          diagnostics,
          async stop(graceMs?: number): Promise<void> {
            runtimeOutput = diagnostics();
            await stop(graceMs);
            runtimeOutput = diagnostics();
          },
        };
      },
      prepare: async ({ descriptor }) => (await session.request<{ debugPort: number }>("runtime.prepare", { descriptor }, { timeoutMs: 5_000 })).data,
      command: async (operation, input, timeoutMs = 10_000) => (await session.request<Record<string, unknown>>("runtime.command", { operation, ...input }, { timeoutMs })).data,
      capture: async (input, timeoutMs = 15_000) => {
        const response = await session.request<RuntimeCaptureFrameMetadata>("runtime.capture", input, { timeoutMs, maxResponseBytes: 8 * 1024 * 1024 });
        return {
          data: response.data,
          ...(response.binary === undefined ? {} : { binary: response.binary }),
          ...(response.binarySha256 === undefined ? {} : { binarySha256: response.binarySha256 }),
        };
      },
      cleanup: async () => { await session.request("runtime.cleanup", {}, { timeoutMs: 5_000 }); },
    });
    const evidence = new EvidenceStore(project.root);
    scenarios = new ScenarioService({ projectId: identity.projectId, sessionId: () => session.sessionId, runtime, evidence });
    const visual = new VisualService({ sessionId: () => session.sessionId, evidence, scenario: scenarios });
    let closePromise: Promise<void> | undefined;
    return {
      projectRoot: project.root,
      visual,
      async run(declaration): Promise<ScenarioReport> {
        const started = scenarios!.start(declaration);
        for (let attempt = 0; attempt < 1_200; attempt += 1) {
          const status = scenarios!.status(started.jobToken);
          if (["completed", "failed", "cancelled"].includes(status.state)) return scenarios!.result(started.jobToken);
          await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
        }
        throw new Error("Phase 8 scenario did not reach a terminal state");
      },
      diagnostics: () => `Editor:\n${editorOutput}\nRuntime:\n${runtimeOutput}`,
      close(): Promise<void> {
        closePromise ??= (async () => {
          await scenarios?.close().catch(() => undefined);
          await runtime?.close().catch(() => undefined);
          await bridge?.close().catch(() => undefined);
          if (editor?.exitCode === null) editor.kill("SIGTERM");
          await attestation?.cleanup();
          const diff = await project.diffFromOriginal();
          await project.cleanup();
          if (previousRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
          else process.env.XDG_RUNTIME_DIR = previousRuntimeDirectory;
          if (previousDataDirectory === undefined) delete process.env.XDG_DATA_HOME;
          else process.env.XDG_DATA_HOME = previousDataDirectory;
          await rm(dataDirectory, { recursive: true, force: true });
          if (diff.length > 0) throw new Error(`Phase 8 fixture changed:\n${diff.join("\n")}`);
        })();
        return closePromise;
      },
    };
  } catch (error) {
    await scenarios?.close().catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    await bridge?.close().catch(() => undefined);
    if (editor?.exitCode === null) editor.kill("SIGTERM");
    await attestation?.cleanup();
    await project.cleanup();
    if (previousRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeDirectory;
    if (previousDataDirectory === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousDataDirectory;
    await rm(dataDirectory, { recursive: true, force: true });
    throw error;
  }
}
