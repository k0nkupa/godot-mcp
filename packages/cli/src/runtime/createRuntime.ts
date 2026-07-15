import { startBridgeServer, type BridgeServer } from "@godot-mcp/bridge-client";
import {
  JsonlAuditSink,
  EvidenceStore,
  SessionService,
  readProjectIdentity,
  type SessionGrants,
} from "@godot-mcp/control-plane";
import { createGodotMcpServer } from "@godot-mcp/mcp-server";
import { PRODUCT_VERSION, type ProjectIdentity } from "@godot-mcp/protocol";

import { readInstallManifest } from "../install/addonManifest.js";
import { runDoctor } from "../install/doctor.js";

export interface RuntimeOptions {
  project: string;
  grants?: SessionGrants;
  godotBin?: string;
}

type GodotMcpServer = ReturnType<typeof createGodotMcpServer>;

export class GodotMcpRuntime {
  private closePromise: Promise<void> | undefined;

  constructor(
    readonly project: ProjectIdentity,
    readonly audit: JsonlAuditSink,
    readonly session: SessionService,
    readonly bridge: BridgeServer,
    readonly mcp: GodotMcpServer,
  ) {}

  close(reason: string): Promise<void> {
    void reason;
    this.closePromise ??= (async () => {
      await this.mcp.close().catch(() => undefined);
      await this.bridge.close().catch(() => undefined);
      this.session.close();
    })();
    return this.closePromise;
  }
}

export async function createRuntime(options: RuntimeOptions): Promise<GodotMcpRuntime> {
  const project = await readProjectIdentity(options.project);
  const manifest = await readInstallManifest(project.rootRealPath);
  const audit = JsonlAuditSink.forProject(project.rootRealPath);
  const grants: SessionGrants = options.grants ?? { tiers: ["observe"], packs: ["core"] };
  const session = new SessionService(project, grants, () => runDoctor(project.rootRealPath));
  let bridge: BridgeServer | undefined;
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
      onDisconnected: () => session.onDisconnected(),
    });
    mcp = createGodotMcpServer({
      project,
      grants,
      audit,
      session,
      bridge: () => bridge?.session ?? null,
      evidence: new EvidenceStore(project.rootRealPath),
    });
    return new GodotMcpRuntime(project, audit, session, bridge, mcp);
  } catch (error) {
    await mcp?.close().catch(() => undefined);
    await bridge?.close().catch(() => undefined);
    throw error;
  }
}
