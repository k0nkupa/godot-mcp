import { constants } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

const CONFIRMATION = "I UNDERSTAND THIS RUNS UNSANDBOXED CODE";
const MAX_LEASE_MS = 5 * 60_000;
const RegistrationSchema = z.object({ registrationId: z.uuid(), templateRoot: z.string().min(1), projectSha256: z.string().regex(/^[a-f0-9]{64}$/), markerNonceSha256: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.string().datetime() }).strict();
const RegistrySchema = z.object({ schemaVersion: z.literal(1), registrations: z.array(RegistrationSchema).max(128) }).strict();
const MarkerSchema = z.object({ schemaVersion: z.literal(1), registrationId: z.uuid(), role: z.enum(["template", "copy"]), disposable: z.literal(true), projectSha256: z.string().regex(/^[a-f0-9]{64}$/), markerNonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/), instanceId: z.uuid().optional() }).strict();
const LeaseSchema = z.object({ schemaVersion: z.literal(1), registrationId: z.uuid(), instanceId: z.uuid(), copyRoot: z.string().min(1), projectSha256: z.string().regex(/^[a-f0-9]{64}$/), markerNonceSha256: z.string().regex(/^[a-f0-9]{64}$/), nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: z.string().datetime() }).strict();

export type UnsafeActivation = z.infer<typeof LeaseSchema>;

function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

async function projectIdentity(root: string): Promise<{ root: string; sha256: string }> {
  const canonical = await realpath(root);
  const config = join(canonical, "project.godot");
  const metadata = await lstat(config);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("Unsafe fixture project.godot must be a regular non-symlink file");
  return { root: canonical, sha256: sha256(await readFile(config)) };
}

async function readOwnerOnlyJson(path: string): Promise<unknown> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > 1024 * 1024) throw new Error("Unsafe authority file must be owner-only, regular, and bounded");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return JSON.parse(await handle.readFile("utf8")); } finally { await handle.close(); }
}

async function atomicOwnerOnlyJson(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const existing = await lstat(path).catch(() => undefined);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error("Unsafe authority destination must not be a symlink");
  const temporary = join(parent, `.unsafe-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function registry(path: string): Promise<z.infer<typeof RegistrySchema>> {
  try { return RegistrySchema.parse(await readOwnerOnlyJson(path)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, registrations: [] };
    throw error;
  }
}

export async function registerUnsafeFixture(registryPath: string, templateRoot: string, confirmation: string): Promise<{ registrationId: string }> {
  if (confirmation !== CONFIRMATION) throw new Error("Exact unsandboxed-code confirmation phrase is required");
  const project = await projectIdentity(templateRoot);
  const current = await registry(registryPath);
  if (current.registrations.some((entry) => entry.templateRoot === project.root)) throw new Error("Unsafe fixture template is already registered");
  const registrationId = randomUUID();
  const markerNonce = randomBytes(32).toString("base64url");
  await atomicOwnerOnlyJson(join(project.root, ".godot-mcp-unsafe-fixture.json"), { schemaVersion: 1, registrationId, role: "template", disposable: true, projectSha256: project.sha256, markerNonce });
  current.registrations.push({ registrationId, templateRoot: project.root, projectSha256: project.sha256, markerNonceSha256: sha256(markerNonce), createdAt: new Date().toISOString() });
  await atomicOwnerOnlyJson(registryPath, current);
  return { registrationId };
}

export async function stampUnsafeFixtureCopy(registryPath: string, copyRoot: string, registrationId: string): Promise<{ instanceId: string }> {
  const current = await registry(registryPath);
  const registration = current.registrations.find((entry) => entry.registrationId === registrationId);
  if (!registration) throw new Error("Unsafe fixture registration was not found");
  const project = await projectIdentity(copyRoot);
  if (project.root === registration.templateRoot) throw new Error("Unsafe execution requires a disposable copy, not the registered template");
  if (project.sha256 !== registration.projectSha256) throw new Error("Unsafe fixture copy project identity differs from its template");
  const templateMarker = MarkerSchema.parse(await readOwnerOnlyJson(join(registration.templateRoot, ".godot-mcp-unsafe-fixture.json")));
  if (templateMarker.registrationId !== registrationId || sha256(templateMarker.markerNonce) !== registration.markerNonceSha256) throw new Error("Unsafe fixture template marker changed");
  const instanceId = randomUUID();
  await atomicOwnerOnlyJson(join(project.root, ".godot-mcp-unsafe-fixture.json"), { ...templateMarker, role: "copy", instanceId });
  return { instanceId };
}

export async function approveUnsafeFixtureCopy(registryPath: string, copyRoot: string, activationDirectory: string, confirmation: string, ttlMs = MAX_LEASE_MS): Promise<{ leasePath: string; expiresAt: string }> {
  if (confirmation !== CONFIRMATION) throw new Error("Exact unsandboxed-code confirmation phrase is required");
  if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_LEASE_MS) throw new Error("Unsafe activation lifetime must be between one second and five minutes");
  const project = await projectIdentity(copyRoot);
  const marker = MarkerSchema.parse(await readOwnerOnlyJson(join(project.root, ".godot-mcp-unsafe-fixture.json")));
  if (marker.role !== "copy" || !marker.instanceId) throw new Error("Unsafe activation requires a stamped disposable copy");
  const registration = (await registry(registryPath)).registrations.find((entry) => entry.registrationId === marker.registrationId);
  if (!registration || project.root === registration.templateRoot || project.sha256 !== registration.projectSha256 || sha256(marker.markerNonce) !== registration.markerNonceSha256) throw new Error("Unsafe fixture copy no longer matches registration");
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const leasePath = resolve(activationDirectory, `unsafe-activation-${randomUUID()}.json`);
  await atomicOwnerOnlyJson(leasePath, { schemaVersion: 1, registrationId: marker.registrationId, instanceId: marker.instanceId, copyRoot: project.root, projectSha256: project.sha256, markerNonceSha256: registration.markerNonceSha256, nonce: randomBytes(32).toString("base64url"), expiresAt });
  return { leasePath, expiresAt };
}

export async function consumeUnsafeFixtureActivation(registryPath: string, copyRoot: string, leasePath: string, now = Date.now()): Promise<UnsafeActivation> {
  let raw: unknown;
  try { raw = await readOwnerOnlyJson(leasePath); } finally { await rm(leasePath, { force: true }); }
  const lease = LeaseSchema.parse(raw);
  const project = await projectIdentity(copyRoot);
  const marker = MarkerSchema.parse(await readOwnerOnlyJson(join(project.root, ".godot-mcp-unsafe-fixture.json")));
  const registration = (await registry(registryPath)).registrations.find((entry) => entry.registrationId === lease.registrationId);
  if (!registration || lease.copyRoot !== project.root || lease.copyRoot === registration.templateRoot || lease.projectSha256 !== project.sha256 || lease.instanceId !== marker.instanceId || lease.markerNonceSha256 !== sha256(marker.markerNonce)) throw new Error("Unsafe activation identity mismatch");
  if (Date.parse(lease.expiresAt) <= now || Date.parse(lease.expiresAt) > now + MAX_LEASE_MS) throw new Error("Unsafe activation expired or has an invalid future lifetime");
  return lease;
}

export const UNSAFE_CONFIRMATION_PHRASE = CONFIRMATION;
