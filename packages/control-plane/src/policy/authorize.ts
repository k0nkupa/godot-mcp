import { randomUUID } from "node:crypto";

import { GodotMcpException } from "../errors.js";
import { expandPermissionTiers, type CommandPolicy, type SessionGrants } from "./capabilities.js";

export function authorize(grants: SessionGrants, policy: CommandPolicy): { allowed: true } {
  const tiers = expandPermissionTiers(grants.tiers);
  const requiredPacks = policy.requiredPacks ?? [policy.pack];
  if (!tiers.includes(policy.tier) || !requiredPacks.every((pack) => grants.packs.includes(pack))) {
    throw new GodotMcpException({
      code: "PERMISSION_REQUIRED",
      message: `${policy.command} requires tier ${policy.tier} and capability packs ${requiredPacks.join(", ")}`,
      retryable: false,
      correlationId: randomUUID(),
      partialEffects: false,
      rollback: "not_needed",
    });
  }
  return { allowed: true };
}
