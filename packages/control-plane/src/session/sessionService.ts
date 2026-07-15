import {
  BRIDGE_PROTOCOL_VERSION,
  PRODUCT_VERSION,
  type GodotMcpError,
  type ProjectIdentity,
} from "@godot-mcp/protocol";

import {
  visibleCapabilities,
  type SessionGrants,
} from "../policy/capabilities.js";
import { getCoreHelp, type CoreHelp, type CoreHelpTopic } from "../help/coreHelp.js";

export type SessionState = "starting" | "waiting_for_addon" | "attached" | "disconnected" | "closed";

export interface PublicAttachment {
  sessionId: string;
  godotVersion: string;
  addonVersion: string;
  addonManifestSha256: string;
  attachedAt: string;
}

export interface PublicSessionSnapshot {
  productVersion: string;
  protocolVersion: string;
  projectId: string;
  projectConfigSha256: string;
  state: SessionState;
  grants: SessionGrants;
  attachment: PublicAttachment | null;
  lastErrorCode: GodotMcpError["code"] | null;
}

export interface CapabilitySummary {
  tiers: SessionGrants["tiers"];
  packs: SessionGrants["packs"];
  operations: string[];
}

export interface DoctorCheck {
  name: string;
  status: "ok" | "warning" | "error";
  detail: string;
}

export interface DoctorResult {
  healthy: boolean;
  checks: DoctorCheck[];
}

export class SessionService {
  private state: SessionState = "waiting_for_addon";
  private attachment: PublicAttachment | null = null;
  private lastErrorCode: GodotMcpError["code"] | null = null;

  constructor(
    private readonly project: ProjectIdentity,
    private readonly grants: SessionGrants,
    private readonly installationDoctor: () => Promise<DoctorResult>,
  ) {}

  onAttached(value: PublicAttachment): void {
    this.attachment = {
      sessionId: value.sessionId,
      godotVersion: value.godotVersion,
      addonVersion: value.addonVersion,
      addonManifestSha256: value.addonManifestSha256,
      attachedAt: value.attachedAt,
    };
    this.lastErrorCode = null;
    this.state = "attached";
  }

  onDisconnected(errorCode: GodotMcpError["code"] | null = null): void {
    this.attachment = null;
    this.lastErrorCode = errorCode;
    this.state = "disconnected";
  }

  close(): void {
    this.attachment = null;
    this.state = "closed";
  }

  snapshot(): PublicSessionSnapshot {
    return {
      productVersion: PRODUCT_VERSION,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      projectId: this.project.projectId,
      projectConfigSha256: this.project.projectConfigSha256,
      state: this.state,
      grants: { tiers: [...this.grants.tiers], packs: [...this.grants.packs] },
      attachment: this.attachment ? { ...this.attachment } : null,
      lastErrorCode: this.lastErrorCode,
    };
  }

  capabilities(): CapabilitySummary {
    return {
      tiers: [...this.grants.tiers],
      packs: [...this.grants.packs],
      operations: visibleCapabilities(this.grants).map((policy) => policy.command),
    };
  }

  async doctor(): Promise<DoctorResult> {
    const installation = await this.installationDoctor();
    const attached = this.state === "attached";
    const liveCheck: DoctorCheck = {
      name: "bridge-session",
      status: attached ? "ok" : "error",
      detail: attached ? "Godot editor addon is attached" : `Bridge session state is ${this.state}`,
    };
    return {
      healthy: installation.healthy && attached,
      checks: [...installation.checks.map((check) => ({ ...check })), liveCheck],
    };
  }

  help(topic?: CoreHelpTopic): CoreHelp {
    return getCoreHelp(topic);
  }
}
