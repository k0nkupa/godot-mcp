import { join } from "node:path";

import { startBridgeServer, type BridgeServer } from "@godot-mcp/bridge-client";
import {
  ArtifactStore,
  EditorMutationService,
  EvidenceStore,
  type ExtensionRegistry,
  JsonlAuditSink,
  MutationLedger,
  OwnedProjectProcess,
  ProjectJobJournal,
  ProjectJobService,
  ProjectMutationJournal,
  ProjectMutationService,
  ProjectService,
  RuntimeService,
  ScenarioService,
  SessionService,
  UnsafeFixtureProcess,
  UnsafeFixtureService,
  VisualService,
  readProjectIdentity,
  projectOperationPreflight,
  recoverOwnedProjectProcess,
  consumeUnsafeFixtureActivation,
  type SessionGrants,
} from "@godot-mcp/control-plane";
import { createGodotMcpServer } from "@godot-mcp/mcp-server";
import {
  PRODUCT_VERSION,
  type ProjectIdentity,
  type RuntimeCaptureFrameMetadata,
} from "@godot-mcp/protocol";

import { readInstallManifest } from "../install/addonManifest.js";
import { runDoctor } from "../install/doctor.js";
import { findGodotBinary } from "../install/pluginState.js";

export interface RuntimeOptions {
  project: string;
  grants?: SessionGrants;
  godotBin?: string;
  unsafeRegistryPath?: string;
  unsafeActivationPath?: string;
  extensions?: ExtensionRegistry;
}

export function normalizeRuntimeGrants(grants: SessionGrants | undefined): SessionGrants {
  if (grants === undefined) return { tiers: ["observe"], packs: ["core"] };
  const tiers = new Set(grants.tiers);
  const packs = new Set(grants.packs);
  for (const tier of tiers) {
    if (tier !== "observe" && tier !== "runtime_control" && tier !== "project_mutate" && tier !== "project_operate" && tier !== "unsafe_fixture") throw new Error(`Unsupported runtime tier: ${tier}`);
  }
  for (const pack of packs) {
    if (pack !== "core" && pack !== "runtime" && pack !== "input" && pack !== "editor" && pack !== "visual" && pack !== "project" && pack !== "unsafe") throw new Error(`Unsupported runtime pack: ${pack}`);
  }
  if (!tiers.has("observe") || !packs.has("core")) throw new Error("observe and core grants are required");
  const hasRuntimePack = packs.has("runtime") || packs.has("input");
  if (tiers.has("runtime_control") !== hasRuntimePack) {
    throw new Error("runtime_control must be granted with runtime or input packs");
  }
  const hasEditorPack = packs.has("editor");
  if (tiers.has("project_mutate") !== hasEditorPack) {
    throw new Error("project_mutate must be granted with the editor pack");
  }
  if (packs.has("visual") && (!packs.has("runtime") || !packs.has("input"))) {
    throw new Error("visual pack requires runtime and input packs");
  }
  const hasProjectPack = packs.has("project");
  if (tiers.has("project_operate") !== hasProjectPack) {
    throw new Error("project_operate must be granted with the project pack");
  }
  const hasUnsafePack = packs.has("unsafe");
  if (tiers.has("unsafe_fixture") !== hasUnsafePack) throw new Error("unsafe_fixture must be granted with the unsafe pack");
  if (!hasRuntimePack && !hasEditorPack && !hasProjectPack && !hasUnsafePack) return { tiers: ["observe"], packs: ["core"] };
  return {
    tiers: ["observe", ...(tiers.has("runtime_control") ? ["runtime_control" as const] : []), ...(tiers.has("project_mutate") ? ["project_mutate" as const] : []), ...(tiers.has("project_operate") ? ["project_operate" as const] : []), ...(tiers.has("unsafe_fixture") ? ["unsafe_fixture" as const] : [])],
    packs: ["core", ...(packs.has("runtime") ? ["runtime" as const] : []), ...(packs.has("input") ? ["input" as const] : []), ...(packs.has("editor") ? ["editor" as const] : []), ...(packs.has("visual") ? ["visual" as const] : []), ...(packs.has("project") ? ["project" as const] : []), ...(packs.has("unsafe") ? ["unsafe" as const] : [])],
  };
}

type GodotMcpServer = ReturnType<typeof createGodotMcpServer>;

export class GodotMcpRuntime {
  private closePromise: Promise<void> | undefined;

  constructor(
    readonly project: ProjectIdentity,
    readonly audit: JsonlAuditSink,
    readonly session: SessionService,
    readonly bridge: BridgeServer,
    readonly runtime: RuntimeService,
    readonly mcp: GodotMcpServer,
    readonly visualScenario?: ScenarioService,
    readonly projectJobs?: ProjectJobService,
    readonly unsafeFixture?: UnsafeFixtureService,
  ) {}

  close(reason: string): Promise<void> {
    void reason;
    if (!this.closePromise) {
      const activeClose = (async () => {
        const runtimeErrors: unknown[] = [];
        for (const close of [
          () => this.unsafeFixture?.close(),
          () => this.projectJobs?.close(),
          () => this.visualScenario?.close(),
          () => this.runtime.close(),
        ]) {
          try { await close(); } catch (error) { runtimeErrors.push(error); }
        }
        await Promise.allSettled([this.mcp.close(), this.bridge.close()]);
        this.session.close();
        if (runtimeErrors.length === 1) throw runtimeErrors[0];
        if (runtimeErrors.length > 1) throw new AggregateError(runtimeErrors, "Runtime shutdown encountered multiple failures");
      })();
      this.closePromise = activeClose;
      void activeClose.catch(() => {
        if (this.closePromise === activeClose) this.closePromise = undefined;
      });
    }
    return this.closePromise;
  }
}

export async function createRuntime(options: RuntimeOptions): Promise<GodotMcpRuntime> {
  const grants = normalizeRuntimeGrants(options.grants);
  const godotBin = await findGodotBinary(options.godotBin);
  const project = await readProjectIdentity(options.project);
  const wantsUnsafe = grants.tiers.includes("unsafe_fixture") && grants.packs.includes("unsafe");
  if (wantsUnsafe !== (options.unsafeRegistryPath !== undefined) || wantsUnsafe !== (options.unsafeActivationPath !== undefined)) {
    throw new Error("Unsafe grants require both explicit registry and one-use activation startup paths, and those paths require unsafe grants");
  }
  const unsafeActivation = wantsUnsafe
    ? await consumeUnsafeFixtureActivation(options.unsafeRegistryPath!, project.rootRealPath, options.unsafeActivationPath!)
    : undefined;
  const manifest = await readInstallManifest(project.rootRealPath);
  const audit = JsonlAuditSink.forProject(project.rootRealPath);
  const session = new SessionService(project, grants, () => runDoctor(project.rootRealPath, godotBin));
  let bridge: BridgeServer | undefined;
  let runtime: RuntimeService | undefined;
  let visualScenario: ScenarioService | undefined;
  let projectJobs: ProjectJobService | undefined;
  let unsafeFixture: UnsafeFixtureService | undefined;
  let mcp: GodotMcpServer | undefined;
  const mutationLedger = grants.packs.includes("editor")
    ? await MutationLedger.open(join(project.rootRealPath, ".godot/evidence/godot-mcp/mutation-journal.jsonl"))
    : undefined;
  const projectMutationJournal = grants.packs.includes("project")
    ? await ProjectMutationJournal.open(join(project.rootRealPath, ".godot/evidence/godot-mcp/project-mutations.jsonl"))
    : undefined;
  const projectJobJournal = grants.packs.includes("project")
    ? await ProjectJobJournal.open(join(project.rootRealPath, ".godot/evidence/godot-mcp/project-jobs.jsonl"))
    : undefined;

  try {
    bridge = await startBridgeServer({
      project,
      grants,
      addonManifestSha256: manifest.manifestSha256,
      auditSink: audit,
      onAttached: (attachedBridge) => {
        session.onAttached({
          sessionId: attachedBridge.sessionId,
          godotVersion: attachedBridge.info.godotVersion,
          addonVersion: PRODUCT_VERSION,
          addonManifestSha256: attachedBridge.info.addonManifestSha256,
          attachedAt: new Date().toISOString(),
        });
      },
      onDisconnected: () => {
        session.onDisconnected();
        void runtime?.disconnect();
      },
    });
    runtime = new RuntimeService({
      project,
      sessionId: () => bridge?.session?.sessionId ?? null,
      godotBin,
      requireAuthenticatedDebuggerMetadata: true,
      prepare: async ({ descriptor }) => {
        const attached = bridge?.session;
        if (!attached) throw new Error("Godot editor addon is not attached");
        return (await attached.request<{ debugPort: number; editorPid: number; debugTransport: "authenticated-editor-session" }>(
          "runtime.prepare",
          { descriptor },
          { timeoutMs: 5_000 },
        )).data;
      },
      command: async (operation, input, timeoutMs = 10_000) => {
        const attached = bridge?.session;
        if (!attached) throw new Error("Godot editor addon is not attached");
        return (await attached.request<unknown>(
          "runtime.command",
          { operation, ...input },
          { timeoutMs },
        )).data;
      },
      capture: async (input, timeoutMs = 15_000) => {
        const attached = bridge?.session;
        if (!attached) throw new Error("Godot editor addon is not attached");
        const response = await attached.request<RuntimeCaptureFrameMetadata>(
          "runtime.capture",
          input,
          { timeoutMs, maxResponseBytes: 8 * 1024 * 1024 },
        );
        return {
          data: response.data,
          ...(response.binary === undefined ? {} : { binary: response.binary }),
          ...(response.binarySha256 === undefined ? {} : { binarySha256: response.binarySha256 }),
        };
      },
      cleanup: async () => {
        const attached = bridge?.session;
        if (!attached) throw new Error("Godot editor addon is not attached");
        await attached.request("runtime.cleanup", {}, { timeoutMs: 5_000 });
      },
    });
    const editor = mutationLedger
      ? new EditorMutationService(
          () => {
            const attached = bridge?.session;
            if (!attached) return null;
            return {
              request: <T>(method: "editor.mutate", params: unknown, requestOptions: { timeoutMs: number; maxResponseBytes: number; correlationId: string }) =>
                attached.request<T>(method, params, requestOptions),
            };
          },
          mutationLedger,
        )
      : undefined;
    const evidence = new EvidenceStore(project.rootRealPath);
    const sessionId = () => bridge?.session?.sessionId ?? null;
    const visual = grants.packs.includes("visual")
      ? (() => {
          visualScenario = new ScenarioService({
            projectId: project.projectId,
            sessionId,
            runtime,
            evidence,
          });
          return new VisualService({ sessionId, evidence, scenario: visualScenario });
        })()
      : undefined;
    if (unsafeActivation) {
      unsafeFixture = new UnsafeFixtureService({
        activation: unsafeActivation,
        sessionId,
        evidence,
        launch: (input) => UnsafeFixtureProcess.launch({ ...input, godotBin }),
      });
      await unsafeFixture.initialize();
    }
    const projectOperations = projectMutationJournal && projectJobJournal
      ? (() => {
          const mutations = new ProjectMutationService(
            () => {
              const attached = bridge?.session;
              if (!attached) return null;
              return {
                request: (method: "project.operation", params: unknown, requestOptions: { timeoutMs: number; maxResponseBytes: number; correlationId: string }) =>
                  attached.request<unknown>(method, params, requestOptions),
              };
            },
            projectMutationJournal,
          );
          projectJobs = new ProjectJobService({
            projectId: project.projectId,
            projectRoot: project.rootRealPath,
            sessionId,
            artifacts: new ArtifactStore(project.rootRealPath),
            journal: projectJobJournal,
            recoverProcess: recoverOwnedProjectProcess,
            preflight: (input) => projectOperationPreflight(project.rootRealPath, input),
            conflictReason: (input) => {
              if (input.operation !== "export_start") return null;
              if (!["idle", "stopped"].includes(runtime!.snapshot().state)) return "Export is unavailable while an MCP-owned runtime is active";
              if (visualScenario?.hasActiveJob()) return "Export is unavailable while a visual scenario is active";
              if (unsafeFixture?.blocksExport()) return "Export is unavailable while unsafe fixture execution or residue is present";
              return null;
            },
            launch: (input) => OwnedProjectProcess.launch({ ...input, godotBin }),
            reimport: async (resourcePaths) => {
              const attached = bridge?.session;
              if (!attached) throw new Error("Godot editor addon is not attached");
              await attached.request("project.operation", { operation: "reimport", resourcePaths }, { timeoutMs: 120_000 });
            },
            evidence,
          });
          return new ProjectService(mutations, projectJobs);
        })()
      : undefined;
    await projectJobs?.recover();
    mcp = createGodotMcpServer({
      project,
      grants,
      audit,
      session,
      bridge: () => bridge?.session ?? null,
      evidence,
      runtime,
      ...(visual === undefined ? {} : { visual }),
      ...(editor === undefined ? {} : { editor }),
      ...(projectOperations === undefined ? {} : { projectOperations }),
      ...(unsafeFixture === undefined ? {} : { unsafeFixture }),
      ...(options.extensions === undefined || !options.extensions.visible(grants) ? {} : {
        extensions: options.extensions,
        extensionContext: (correlationId: string) => ({
          project,
          correlationId,
          evidence: { putJson: async (value: unknown, metadata: Record<string, unknown>) => {
            const attachedSession = sessionId();
            if (!attachedSession) throw new Error("Godot editor addon is not attached");
            return (await evidence.putJson(attachedSession, value, metadata)).observationUri;
          } },
        }),
      }),
    });
    return new GodotMcpRuntime(project, audit, session, bridge, runtime, mcp, visualScenario, projectJobs, unsafeFixture);
  } catch (error) {
    await unsafeFixture?.close().catch(() => undefined);
    await projectJobs?.close().catch(() => undefined);
    await visualScenario?.close().catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    await mcp?.close().catch(() => undefined);
    await bridge?.close().catch(() => undefined);
    throw error;
  }
}
