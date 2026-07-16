import { randomBytes, randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { ProjectIdentitySchema, RuntimeHandleSchema, type ProjectIdentity } from "@godot-mcp/protocol";
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
    descriptor.scenePath !== expected.scenePath
  ) {
    throw authenticationFailed("Runtime descriptor identity does not match the prepared run");
  }
}

export async function createRuntimeDescriptor(input: RuntimeDescriptorInput): Promise<RuntimeDescriptorMaterial> {
  const directory = await ensureRuntimeDirectory();
  const now = input.now ?? Date.now();
  const secret = randomBytes(32);
  const descriptor = RuntimeDescriptorSchema.parse({
    project: input.project,
    sessionId: input.sessionId,
    runId: input.runId,
    generation: input.generation,
    scenePath: input.scenePath,
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
