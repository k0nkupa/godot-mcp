import { startBridgeServer, type BridgeServer } from "@godot-mcp/bridge-client";
import {
  JsonlAuditSink,
  EvidenceStore,
  RuntimeService,
  SessionService,
  readProjectIdentity,
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

export interface RuntimeOptions {
  project: string;
  grants?: SessionGrants;
  godotBin?: string;
}

function normalizeRuntimeGrants(grants: SessionGrants | undefined): SessionGrants {
  if (grants === undefined) return { tiers: ["observe"], packs: ["core"] };
  const tiers = new Set(grants.tiers);
  const packs = new Set(grants.packs);
  for (const tier of tiers) {
    if (tier !== "observe" && tier !== "runtime_control") throw new Error(`Unsupported runtime tier: ${tier}`);
  }
  for (const pack of packs) {
    if (pack !== "core" && pack !== "runtime") throw new Error(`Unsupported runtime pack: ${pack}`);
  }
  if (!tiers.has("observe") || !packs.has("core")) throw new Error("observe and core grants are required");
  if (tiers.has("runtime_control") !== packs.has("runtime")) {
    throw new Error("runtime_control and runtime must be granted together");
  }
  return tiers.has("runtime_control")
    ? { tiers: ["observe", "runtime_control"], packs: ["core", "runtime"] }
    : { tiers: ["observe"], packs: ["core"] };
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
  ) {}

  close(reason: string): Promise<void> {
    void reason;
    if (!this.closePromise) {
      const activeClose = (async () => {
        let runtimeError: unknown;
        try {
          await this.runtime.close();
        } catch (error) {
          runtimeError = error;
        }
        await Promise.allSettled([this.mcp.close(), this.bridge.close()]);
        this.session.close();
        if (runtimeError) throw runtimeError;
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
  const project = await readProjectIdentity(options.project);
  const manifest = await readInstallManifest(project.rootRealPath);
  const audit = JsonlAuditSink.forProject(project.rootRealPath);
  const session = new SessionService(project, grants, () => runDoctor(project.rootRealPath));
  let bridge: BridgeServer | undefined;
  let runtime: RuntimeService | undefined;
  let mcp: GodotMcpServer | undefined;

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
      ...(options.godotBin === undefined ? {} : { godotBin: options.godotBin }),
      prepare: async ({ descriptor }) => {
        const attached = bridge?.session;
        if (!attached) throw new Error("Godot editor addon is not attached");
        return (await attached.request<{ debugPort: number; editorPid: number }>(
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
    mcp = createGodotMcpServer({
      project,
      grants,
      audit,
      session,
      bridge: () => bridge?.session ?? null,
      evidence: new EvidenceStore(project.rootRealPath),
      runtime,
    });
    return new GodotMcpRuntime(project, audit, session, bridge, runtime, mcp);
  } catch (error) {
    await runtime?.close().catch(() => undefined);
    await mcp?.close().catch(() => undefined);
    await bridge?.close().catch(() => undefined);
    throw error;
  }
}
