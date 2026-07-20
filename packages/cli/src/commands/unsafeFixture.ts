import { homedir } from "node:os";
import { join } from "node:path";

import { approveUnsafeFixtureCopy, registerUnsafeFixture, stampUnsafeFixtureCopy } from "@godot-mcp/control-plane";

export function defaultUnsafeRegistryPath(): string { return join(homedir(), ".config", "godot-mcp", "unsafe-fixtures.json"); }

export async function registerUnsafeFixtureCommand(project: string, registryPath: string, confirmation: string): Promise<unknown> {
  return registerUnsafeFixture(registryPath, project, confirmation);
}

export async function stampUnsafeFixtureCopyCommand(project: string, registryPath: string, registrationId: string): Promise<unknown> {
  return stampUnsafeFixtureCopy(registryPath, project, registrationId);
}

export async function approveUnsafeFixtureCommand(project: string, registryPath: string, activationDirectory: string, confirmation: string, ttlMs?: number): Promise<unknown> {
  return approveUnsafeFixtureCopy(registryPath, project, activationDirectory, confirmation, ttlMs);
}
