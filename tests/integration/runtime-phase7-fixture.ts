import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { startBridgeServer } from "@godot-mcp/bridge-client";
import { initProject } from "@godot-mcp/cli";
import {
  createRuntimeDescriptor,
  JsonlAuditSink,
  OwnedGodotProcess,
  readProjectIdentity,
  RuntimeService,
} from "@godot-mcp/control-plane";
import {
  copyFixture,
  findGodotBinary,
  launchEditor,
  reserveLoopbackPort,
  reserveLoopbackPortInRange,
  runGodot,
  type EditorProcess,
} from "@godot-mcp/testkit";

export interface Phase7RuntimeFixture {
  projectRoot: string;
  dapPort: number;
  runtime: RuntimeService;
  editor: EditorProcess;
  diagnostics(): string;
  close(): Promise<void>;
}

export async function createPhase7RuntimeFixture(): Promise<Phase7RuntimeFixture> {
  const project = await copyFixture();
  const previousRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = join(project.root, "runtime-dir");
  let editor: EditorProcess | undefined;
  let runtime: RuntimeService | undefined;
  let runtimeOutput = "";
  let runtimePid: number | undefined;
  let runtimeDiagnostics: (() => string) | undefined;
  let bridge: Awaited<ReturnType<typeof startBridgeServer>> | undefined;
  try {
    const imported = await runGodot(["--headless", "--editor", "--path", project.root, "--import"]);
    if (imported.exitCode !== 0) throw new Error(`Fixture import failed: ${imported.stderr}`);
    await initProject(project.root, resolve(process.cwd(), "addons/godot_mcp"), process.env.GODOT_BIN);
    await project.snapshot();
    const identity = await readProjectIdentity(project.root);
    const manifest = JSON.parse(await readFile(join(project.root, ".godot/godot-mcp/install-manifest.json"), "utf8")) as { manifestSha256: string };
    bridge = await startBridgeServer({
      project: identity,
      grants: { tiers: ["observe", "runtime_control"], packs: ["core", "runtime"] },
      addonManifestSha256: manifest.manifestSha256,
      auditSink: new JsonlAuditSink(join(dirname(project.root), "runtime-phase7-audit.jsonl")),
    });
    const debugServerPort = await reserveLoopbackPort();
    let dapPort = await reserveLoopbackPortInRange(1_024, 49_151);
    while (dapPort === debugServerPort) dapPort = await reserveLoopbackPortInRange(1_024, 49_151);
    editor = await launchEditor(project.root, { headless: true, debugServerPort, dapPort });
    const session = await bridge.waitForAttachment(15_000);
    let bridgeState = "attached";
    session.onRejected((code) => { bridgeState = `rejected:${code}`; });
    session.onClose(() => { bridgeState = `${bridgeState}:closed`; });
    runtime = new RuntimeService({
      project: identity,
      sessionId: () => session.sessionId,
      godotBin: await findGodotBinary(),
      createDescriptor: createRuntimeDescriptor,
      launchProcess: async (input) => {
        const owned = await OwnedGodotProcess.launch(input);
        runtimePid = owned.pid;
        const diagnostics = owned.diagnostics.bind(owned);
        runtimeDiagnostics = diagnostics;
        const stop = owned.stop.bind(owned);
        void owned.wait().then((code) => {
          runtimeOutput = `${diagnostics()}\n[exit code ${code}]`;
          runtimeDiagnostics = () => runtimeOutput;
        });
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
      prepare: async ({ descriptor }) => (await session.request<{ debugPort: number; editorPid: number; debugTransport: "authenticated-editor-session" }>(
        "runtime.prepare",
        { descriptor },
        { timeoutMs: 5_000 },
      )).data,
      command: async (operation, input, timeoutMs = 10_000) => (await session.request<Record<string, unknown>>(
        "runtime.command",
        { operation, ...input },
        { timeoutMs },
      )).data,
      cleanup: async () => {
        await session.request("runtime.cleanup", {}, { timeoutMs: 5_000 });
      },
    });
    let closePromise: Promise<void> | undefined;
    return {
      projectRoot: project.root,
      dapPort,
      runtime,
      editor,
      diagnostics: () => `Bridge: ${bridgeState}\nEditor (${processExists(editor?.pid) ? "alive" : "exited"}):\n${editor?.output ?? ""}\nRuntime (${processExists(runtimePid) ? "alive" : "exited"}):\n${runtimeDiagnostics?.() ?? runtimeOutput}`,
      close(): Promise<void> {
        closePromise ??= (async () => {
          await runtime?.close().catch(() => undefined);
          await bridge?.close().catch(() => undefined);
          await editor?.close().catch(() => undefined);
          let fixtureError: Error | undefined;
          try {
            const diff = await project.diffFromOriginal();
            if (diff.length > 0) fixtureError = new Error(`Phase 7 fixture changed:\n${diff.join("\n")}`);
          } finally {
            await project.cleanup();
            if (previousRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
            else process.env.XDG_RUNTIME_DIR = previousRuntimeDirectory;
          }
          if (fixtureError) throw fixtureError;
        })();
        return closePromise;
      },
    };
  } catch (error) {
    await runtime?.close().catch(() => undefined);
    await bridge?.close().catch(() => undefined);
    await editor?.close().catch(() => undefined);
    await project.cleanup();
    if (previousRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeDirectory;
    throw error;
  }
}

function processExists(pid: number | undefined): boolean {
  if (!pid || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
