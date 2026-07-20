import { randomBytes, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { canonicalJson, ProjectIdentitySchema, RuntimeHandleSchema, RuntimeLaunchPinsSchema, type ProjectIdentity, type RuntimeLaunchPins } from "@godot-mcp/protocol";
import { z } from "zod";

import { GodotMcpException } from "../errors.js";
import { ensureRuntimeDirectory } from "../auth/runtimeDirectory.js";

export const RuntimeDescriptorSchema = z
  .object({
    project: ProjectIdentitySchema,
    sessionId: z.string().min(16).max(256),
    runId: RuntimeHandleSchema.shape.runId,
    generation: RuntimeHandleSchema.shape.generation,
    scenePath: z.string().startsWith("res://").endsWith(".tscn").max(512),
    pins: RuntimeLaunchPinsSchema.optional(),
    ownerLeasePath: z.string().min(1).max(1024),
    secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    launchNonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    createdAtUnixMs: z.number().int().nonnegative(),
    expiresAtUnixMs: z.number().int().positive(),
  })
  .strict();

export type RuntimeDescriptor = z.infer<typeof RuntimeDescriptorSchema>;

export interface RuntimeDescriptorInput {
  project: ProjectIdentity;
  sessionId: string;
  runId: string;
  generation: number;
  scenePath: string;
  pins?: RuntimeLaunchPins;
  now?: number;
}

export interface RuntimeDescriptorMaterial {
  path: string;
  descriptor: RuntimeDescriptor;
  secret: Uint8Array;
  consume?(): Promise<void>;
  cleanup(): Promise<void>;
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

function assertExpected(descriptor: RuntimeDescriptor, expected: RuntimeDescriptorInput): void {
  if (
    descriptor.project.projectId !== expected.project.projectId ||
    descriptor.project.projectConfigSha256 !== expected.project.projectConfigSha256 ||
    descriptor.sessionId !== expected.sessionId ||
    descriptor.runId !== expected.runId ||
    descriptor.generation !== expected.generation ||
    descriptor.scenePath !== expected.scenePath ||
    canonicalJson(descriptor.pins ?? null) !== canonicalJson(expected.pins ?? null)
  ) {
    throw authenticationFailed("Runtime descriptor identity does not match the prepared run");
  }
}

async function pruneOrphanedRuntimeFiles(directory: string, now: number): Promise<void> {
  const names = (await readdir(directory).catch(() => []))
    .filter((name) => name.startsWith("runtime-") || name.startsWith(".consuming-runtime-"))
    .slice(0, 256);
  const referencedLeases = new Set<string>();
  for (const name of names) {
    if (!name.startsWith("runtime-") || !name.endsWith(".json")) continue;
    const path = join(directory, name);
    let descriptor: RuntimeDescriptor | undefined;
    try {
      descriptor = RuntimeDescriptorSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch {
      const metadata = await lstat(path).catch(() => undefined);
      if (metadata && now - metadata.mtimeMs > 60_000) await rm(path, { force: true });
      continue;
    }
    const leaseName = basename(descriptor.ownerLeasePath);
    const leasePath = join(directory, leaseName);
    if (dirname(descriptor.ownerLeasePath) !== directory || !leaseName.startsWith("runtime-") || !leaseName.endsWith(".lease")) continue;
    referencedLeases.add(leaseName);
    const lease = await lstat(leasePath).catch(() => undefined);
    if (descriptor.expiresAtUnixMs < now || !lease || now - lease.mtimeMs > 4_000) {
      await Promise.all([rm(path, { force: true }), rm(leasePath, { force: true })]);
    }
  }
  for (const name of names) {
    const path = join(directory, name);
    if (name.startsWith("runtime-") && name.endsWith(".lease") && !referencedLeases.has(name)) {
      const metadata = await lstat(path).catch(() => undefined);
      if (metadata && now - metadata.mtimeMs > 4_000) await rm(path, { force: true });
    } else if (name.startsWith(".consuming-runtime-")) {
      const metadata = await lstat(path).catch(() => undefined);
      if (metadata && now - metadata.mtimeMs > 60_000) await rm(path, { force: true });
    }
  }
}

export async function createRuntimeDescriptor(input: RuntimeDescriptorInput): Promise<RuntimeDescriptorMaterial> {
  const directory = await ensureRuntimeDirectory();
  const now = input.now ?? Date.now();
  await pruneOrphanedRuntimeFiles(directory, now);
  const secret = randomBytes(32);
  const descriptor = RuntimeDescriptorSchema.parse({
    project: input.project,
    sessionId: input.sessionId,
    runId: input.runId,
    generation: input.generation,
    scenePath: input.scenePath,
    ...(input.pins ? { pins: input.pins } : {}),
    ownerLeasePath: join(directory, `runtime-${input.project.projectId}-${input.runId}.lease`),
    secret: secret.toString("base64url"),
    launchNonce: randomBytes(32).toString("base64url"),
    createdAtUnixMs: now,
    expiresAtUnixMs: now + 60_000,
  });
  const path = join(directory, `runtime-${input.project.projectId}-${input.runId}.json`);
  const ownerLeasePath = descriptor.ownerLeasePath;
  await writeFile(ownerLeasePath, "owner\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await writeFile(path, `${JSON.stringify(descriptor)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    await rm(ownerLeasePath, { force: true }).catch(() => undefined);
    throw error;
  }
  const heartbeat = setInterval(() => {
    const heartbeatAt = new Date();
    void utimes(ownerLeasePath, heartbeatAt, heartbeatAt).catch(() => undefined);
  }, 250);
  heartbeat.unref();
  let consumed = false;
  let cleaned = false;
  return {
    path,
    descriptor,
    secret,
    async consume(): Promise<void> {
      if (consumed || cleaned) return;
      secret.fill(0);
      descriptor.secret = "";
      await rm(path, { force: true });
      consumed = true;
    },
    async cleanup(): Promise<void> {
      if (cleaned) return;
      clearInterval(heartbeat);
      secret.fill(0);
      descriptor.secret = "";
      await Promise.all([rm(path, { force: true }), rm(ownerLeasePath, { force: true })]);
      cleaned = true;
    },
  };
}

export async function consumeRuntimeDescriptor(path: string, expected: RuntimeDescriptorInput): Promise<RuntimeDescriptor> {
  const consumingPath = join(dirname(path), `.consuming-${basename(path)}-${randomUUID()}`);
  try {
    await rename(path, consumingPath);
  } catch {
    throw authenticationFailed("Runtime descriptor is missing or already consumed");
  }
  try {
    const metadata = await lstat(consumingPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
      throw authenticationFailed("Runtime descriptor permissions are invalid");
    }
    let descriptor: RuntimeDescriptor;
    try {
      descriptor = RuntimeDescriptorSchema.parse(JSON.parse(await readFile(consumingPath, "utf8")));
    } catch {
      throw authenticationFailed("Runtime descriptor is malformed");
    }
    assertExpected(descriptor, expected);
    if (descriptor.expiresAtUnixMs < (expected.now ?? Date.now())) {
      throw authenticationFailed("Runtime descriptor has expired");
    }
    return descriptor;
  } finally {
    await rm(consumingPath, { force: true });
  }
}
