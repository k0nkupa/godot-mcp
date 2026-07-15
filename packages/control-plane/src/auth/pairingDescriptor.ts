import { randomBytes, randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  BRIDGE_PROTOCOL_VERSION,
  CapabilityPackSchema,
  PermissionTierSchema,
  PRODUCT_VERSION,
  ProjectIdentitySchema,
} from "@godot-mcp/protocol";
import { z } from "zod";

import { GodotMcpException } from "../errors.js";
import type { SessionGrants } from "../policy/capabilities.js";
import { ensureRuntimeDirectory } from "./runtimeDirectory.js";

export const PairingDescriptorSchema = z.object({
  protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
  productVersion: z.literal(PRODUCT_VERSION),
  project: ProjectIdentitySchema,
  port: z.number().int().min(1).max(65_535),
  sessionNonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  grants: z.object({
    tiers: z.array(PermissionTierSchema),
    packs: z.array(CapabilityPackSchema),
  }),
  createdAtUnixMs: z.number().int().positive(),
  expiresAtUnixMs: z.number().int().positive(),
});

export type SessionDescriptor = z.infer<typeof PairingDescriptorSchema>;

export interface PairingMaterial {
  path: string;
  descriptor: SessionDescriptor;
}

function authenticationFailed(message: string): GodotMcpException {
  return new GodotMcpException({
    code: "AUTHENTICATION_FAILED",
    message,
    retryable: false,
    correlationId: randomUUID(),
    partialEffects: false,
    rollback: "not_needed",
  });
}

export async function createPairingDescriptor(
  project: SessionDescriptor["project"],
  port: number,
  grants: SessionGrants,
): Promise<PairingMaterial> {
  const runtimeDirectory = await ensureRuntimeDirectory();
  const now = Date.now();
  const descriptor = PairingDescriptorSchema.parse({
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    productVersion: PRODUCT_VERSION,
    project,
    port,
    sessionNonce: randomBytes(32).toString("base64url"),
    token: randomBytes(32).toString("base64url"),
    grants,
    createdAtUnixMs: now,
    expiresAtUnixMs: now + 60_000,
  });
  const path = join(runtimeDirectory, `pair-${project.projectId}.json`);
  try {
    await writeFile(path, `${JSON.stringify(descriptor)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw authenticationFailed("A pairing descriptor already exists for this project");
    }
    throw error;
  }
  return { path, descriptor };
}

export async function consumePairingDescriptor(path: string): Promise<SessionDescriptor> {
  const consumingPath = join(dirname(path), `.consuming-${basename(path)}-${randomUUID()}`);
  try {
    await rename(path, consumingPath);
  } catch {
    throw authenticationFailed("Pairing descriptor is missing or already consumed");
  }

  try {
    const metadata = await lstat(consumingPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
      throw authenticationFailed("Pairing descriptor permissions are invalid");
    }
    let descriptor: SessionDescriptor;
    try {
      descriptor = PairingDescriptorSchema.parse(JSON.parse(await readFile(consumingPath, "utf8")));
    } catch {
      throw authenticationFailed("Pairing descriptor is malformed");
    }
    if (descriptor.expiresAtUnixMs < Date.now()) {
      throw authenticationFailed("Pairing descriptor has expired");
    }
    return descriptor;
  } finally {
    await rm(consumingPath, { force: true });
  }
}
