import type { CapabilityPack, PermissionTier } from "@godot-mcp/protocol";

export interface SessionGrants {
  tiers: PermissionTier[];
  packs: CapabilityPack[];
}

export interface CommandPolicy {
  command: string;
  tier: PermissionTier;
  pack: CapabilityPack;
  mutating: boolean;
}

const TIER_EXPANSION: Record<PermissionTier, readonly PermissionTier[]> = {
  observe: ["observe"],
  runtime_control: ["observe", "runtime_control"],
  project_mutate: ["observe", "runtime_control", "project_mutate"],
  project_operate: ["observe", "runtime_control", "project_mutate", "project_operate"],
  unsafe_fixture: ["observe", "unsafe_fixture"],
};

const TIER_ORDER: readonly PermissionTier[] = [
  "observe",
  "runtime_control",
  "project_mutate",
  "project_operate",
  "unsafe_fixture",
];

export function expandPermissionTiers(tiers: readonly PermissionTier[]): PermissionTier[] {
  const expanded = new Set<PermissionTier>();
  for (const tier of tiers) {
    for (const implied of TIER_EXPANSION[tier]) expanded.add(implied);
  }
  return TIER_ORDER.filter((tier) => expanded.has(tier));
}

export const CORE_CAPABILITIES_POLICY: CommandPolicy = {
  command: "godot_capabilities",
  tier: "observe",
  pack: "core",
  mutating: false,
};
export const CORE_DOCTOR_POLICY: CommandPolicy = {
  command: "godot_doctor",
  tier: "observe",
  pack: "core",
  mutating: false,
};
export const CORE_HELP_POLICY: CommandPolicy = {
  command: "godot_help",
  tier: "observe",
  pack: "core",
  mutating: false,
};
export const CORE_SESSION_POLICY: CommandPolicy = {
  command: "godot_session",
  tier: "observe",
  pack: "core",
  mutating: false,
};
export const CORE_QUERY_POLICY: CommandPolicy = {
  command: "godot_query",
  tier: "observe",
  pack: "core",
  mutating: false,
};
export const CORE_CAPTURE_POLICY: CommandPolicy = {
  command: "godot_capture",
  tier: "observe",
  pack: "core",
  mutating: false,
};

export const PHASE_ONE_POLICIES: readonly CommandPolicy[] = [
  CORE_CAPABILITIES_POLICY,
  CORE_DOCTOR_POLICY,
  CORE_HELP_POLICY,
  CORE_SESSION_POLICY,
];

export const CORE_POLICIES: readonly CommandPolicy[] = [
  CORE_CAPABILITIES_POLICY,
  CORE_CAPTURE_POLICY,
  CORE_DOCTOR_POLICY,
  CORE_HELP_POLICY,
  CORE_QUERY_POLICY,
  CORE_SESSION_POLICY,
];

export function visibleCapabilities(grants: SessionGrants): CommandPolicy[] {
  const tiers = expandPermissionTiers(grants.tiers);
  return CORE_POLICIES.filter(
    (policy) => tiers.includes(policy.tier) && grants.packs.includes(policy.pack),
  );
}
