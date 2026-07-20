import type { z } from "zod";

import type { ProjectIdentity } from "@godot-mcp/protocol";

import type { CommandPolicy, SessionGrants } from "../policy/capabilities.js";
import { expandPermissionTiers } from "../policy/capabilities.js";
import { visibleCapabilities } from "../policy/capabilities.js";

const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const EXTENSION_POLICIES = visibleCapabilities({ tiers: ["observe", "runtime_control", "project_mutate", "project_operate"], packs: ["core", "runtime", "input", "editor", "debug", "visual", "project"] });

export interface ExtensionEvidenceWriter {
  putJson(value: unknown, metadata: Record<string, unknown>): Promise<string>;
}

export interface ExtensionContext {
  readonly project: Readonly<ProjectIdentity>;
  readonly correlationId: string;
  readonly evidence: ExtensionEvidenceWriter;
}

export interface ExtensionDefinition<Input = unknown, Output = unknown> {
  extension: string;
  operation: string;
  policy: CommandPolicy;
  inputSchema: z.ZodType<Input>;
  outputSchema: z.ZodType<Output>;
  audit(input: Input): Record<string, unknown>;
  handler(context: ExtensionContext, input: Input): Promise<Output>;
}

export class ExtensionRegistry {
  private readonly definitions = new Map<string, ExtensionDefinition>();

  register<Input, Output>(definition: ExtensionDefinition<Input, Output>): void {
    if (!NAME.test(definition.extension) || !NAME.test(definition.operation)) throw new Error("Extension and operation names must be bounded lowercase identifiers");
    if (definition.policy.tier === "unsafe_fixture" || definition.policy.pack === "unsafe") throw new Error("Extensions cannot acquire unsafe fixture authority");
    const knownPolicy = EXTENSION_POLICIES.find((policy) => policy.command === definition.policy.command);
    if (!knownPolicy || knownPolicy.tier !== definition.policy.tier || knownPolicy.pack !== definition.policy.pack || JSON.stringify(knownPolicy.requiredPacks ?? []) !== JSON.stringify(definition.policy.requiredPacks ?? [])) {
      throw new Error("Extension operations must use an exact existing control-plane policy");
    }
    const key = this.key(definition.extension, definition.operation);
    if (this.definitions.has(key)) throw new Error("Duplicate extension operation");
    this.definitions.set(key, definition as ExtensionDefinition);
  }

  resolve(extension: string, operation: string): ExtensionDefinition {
    const definition = this.definitions.get(this.key(extension, operation));
    if (!definition) throw new Error("Extension operation is not registered at startup");
    return definition;
  }

  visible(grants: SessionGrants): boolean {
    const tiers = expandPermissionTiers(grants.tiers);
    return [...this.definitions.values()].some((definition) => tiers.includes(definition.policy.tier) && (definition.policy.requiredPacks ?? [definition.policy.pack]).every((pack) => grants.packs.includes(pack)));
  }

  list(): Array<{ extension: string; operation: string; policy: CommandPolicy }> {
    return [...this.definitions.values()].map(({ extension, operation, policy }) => ({ extension, operation, policy: { ...policy } }));
  }

  private key(extension: string, operation: string): string { return `${extension}\0${operation}`; }
}
