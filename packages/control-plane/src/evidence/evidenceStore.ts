import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson } from "@godot-mcp/protocol";

import { GodotMcpException } from "../errors.js";

const MAX_PNG_BYTES = 8 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const SESSION_PATTERN = /^session_[A-Za-z0-9_-]{8,128}$/;
const BASELINE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const OBSERVATION_URI_PATTERN = /^godot-mcp:\/\/evidence\/([a-f0-9]{64})\/observations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export interface PngEvidenceMetadata {
  viewport: "2d" | "3d" | "runtime";
  width: number;
  height: number;
  viewportIndex?: number;
  source?: "editor" | "runtime";
  runId?: string;
  generation?: number;
  frameIndex?: number;
}

export interface EvidenceReference {
  uri: `godot-mcp://evidence/${string}`;
  observationUri: `godot-mcp://evidence/${string}`;
  sha256: string;
  mimeType: "image/png";
  byteLength: number;
  path: string;
  observationPath: string;
}

export interface JsonEvidenceReference {
  uri: `godot-mcp://evidence/${string}`;
  observationUri: `godot-mcp://evidence/${string}`;
  sha256: string;
  mimeType: "application/json";
  byteLength: number;
  path: string;
  observationPath: string;
}

export interface PngObservation {
  data: Uint8Array;
  sha256: string;
  mimeType: "image/png";
  byteLength: number;
  width: number;
  height: number;
  observationUri: `godot-mcp://evidence/${string}`;
}

export interface PngBaselineManifest {
  schemaVersion: 1;
  comparisonContractVersion: 1;
  name: string;
  sha256: string;
  mimeType: "image/png";
  byteLength: number;
  width: number;
  height: number;
  sourceObservationSha256: string;
  createdAtUnixMs: number;
}

function evidenceError(
  code: "PATH_DENIED" | "INVALID_REQUEST" | "PAYLOAD_TOO_LARGE" | "CONFLICT" | "STALE_HANDLE" | "PRECONDITION_FAILED",
  message: string,
): GodotMcpException {
  return new GodotMcpException({
    code,
    message,
    retryable: false,
    correlationId: randomUUID(),
    partialEffects: false,
    rollback: "not_needed",
  });
}

async function atomicWrite(path: string, contents: Uint8Array | string): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function atomicWriteOnce(path: string, contents: Uint8Array | string): Promise<boolean> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readPlainFile(path: string): Promise<Buffer> {
  const metadata = await lstat(path).catch(() => undefined);
  if (!metadata) throw evidenceError("PRECONDITION_FAILED", "Visual evidence is unavailable");
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw evidenceError("PATH_DENIED", "Visual evidence must be a regular non-symlink file");
  }
  return readFile(path);
}

async function readOptionalPlainFile(path: string): Promise<Buffer | undefined> {
  return readPlainFile(path).catch((error: unknown) => {
    if (error instanceof GodotMcpException && error.code === "PRECONDITION_FAILED") return undefined;
    throw error;
  });
}

async function plainDirectory(root: string, segments: string[], create: boolean): Promise<string> {
  let current = root;
  const rootMetadata = await lstat(current).catch(() => undefined);
  if (!rootMetadata || rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw evidenceError("PATH_DENIED", "Evidence root must be a regular non-symlink directory");
  }
  for (const segment of segments) {
    current = join(current, segment);
    let metadata = await lstat(current).catch(() => undefined);
    if (!metadata && create) {
      await mkdir(current, { mode: 0o700 }).catch(async (error: unknown) => {
        if (!(await lstat(current).catch(() => undefined))) throw error;
      });
      metadata = await lstat(current).catch(() => undefined);
    }
    if (!metadata) throw evidenceError("PRECONDITION_FAILED", "Visual evidence directory is unavailable");
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw evidenceError("PATH_DENIED", "Visual evidence directories must not be symbolic links");
    }
  }
  return current;
}

function observationIdentity(uri: string): { sha256: string; observationId: string } {
  const match = OBSERVATION_URI_PATTERN.exec(uri);
  if (!match) throw evidenceError("PATH_DENIED", "Evidence observation URI is invalid");
  return { sha256: match[1]!, observationId: match[2]! };
}

function validateSessionId(sessionId: string): void {
  if (!SESSION_PATTERN.test(sessionId)) throw evidenceError("PATH_DENIED", "Evidence session identifier is invalid");
}

function validateBaselineName(name: string): void {
  if (!BASELINE_NAME_PATTERN.test(name)) throw evidenceError("PATH_DENIED", "Visual baseline name is invalid");
}

function parsePngBaselineManifest(value: unknown, expectedName: string): PngBaselineManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw evidenceError("CONFLICT", "Visual baseline manifest is malformed");
  }
  const manifest = value as Record<string, unknown>;
  const keys = Object.keys(manifest).sort();
  const expectedKeys = [
    "byteLength", "comparisonContractVersion", "createdAtUnixMs", "height", "mimeType", "name",
    "schemaVersion", "sha256", "sourceObservationSha256", "width",
  ].sort();
  if (
    JSON.stringify(keys) !== JSON.stringify(expectedKeys) ||
    manifest.schemaVersion !== 1 ||
    manifest.comparisonContractVersion !== 1 ||
    manifest.name !== expectedName ||
    typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
    manifest.mimeType !== "image/png" ||
    !Number.isInteger(manifest.byteLength) || Number(manifest.byteLength) < 1 || Number(manifest.byteLength) > MAX_PNG_BYTES ||
    !Number.isInteger(manifest.width) || Number(manifest.width) < 1 || Number(manifest.width) > 2048 ||
    !Number.isInteger(manifest.height) || Number(manifest.height) < 1 || Number(manifest.height) > 2048 ||
    typeof manifest.sourceObservationSha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sourceObservationSha256) ||
    !Number.isInteger(manifest.createdAtUnixMs) || Number(manifest.createdAtUnixMs) < 0
  ) throw evidenceError("CONFLICT", "Visual baseline manifest is malformed");
  return manifest as unknown as PngBaselineManifest;
}

export class EvidenceStore {
  constructor(private readonly projectRoot: string) {}

  async putPng(
    sessionId: string,
    png: Uint8Array,
    metadata: PngEvidenceMetadata,
  ): Promise<EvidenceReference> {
    validateSessionId(sessionId);
    if (png.byteLength > MAX_PNG_BYTES) {
      throw evidenceError("PAYLOAD_TOO_LARGE", "PNG evidence exceeds 8 MiB");
    }
    if (png.byteLength < PNG_SIGNATURE.length || !Buffer.from(png).subarray(0, 8).equals(PNG_SIGNATURE)) {
      throw evidenceError("INVALID_REQUEST", "Evidence bytes are not a PNG");
    }
    const sha256 = createHash("sha256").update(png).digest("hex");
    const directory = await plainDirectory(this.projectRoot, [".godot", "evidence", "godot-mcp", "sessions", sessionId], true);
    const path = join(directory, `${sha256}.png`);
    const existing = await readOptionalPlainFile(path);
    if (existing) {
      const existingSha256 = createHash("sha256").update(existing).digest("hex");
      if (existingSha256 !== sha256) {
        throw evidenceError("CONFLICT", "Existing evidence digest conflicts");
      }
    } else {
      await atomicWrite(path, png);
    }
    const metadataPath = join(directory, `${sha256}.json`);
    const metadataContents = `${JSON.stringify({
      sha256,
      mimeType: "image/png",
      byteLength: png.byteLength,
      width: metadata.width,
      height: metadata.height,
    })}\n`;
    if (!(await readOptionalPlainFile(metadataPath))) {
      await atomicWrite(metadataPath, metadataContents);
    }
    const observationId = randomUUID();
    const observationDirectory = await plainDirectory(this.projectRoot, [".godot", "evidence", "godot-mcp", "sessions", sessionId, `${sha256}.observations`], true);
    const observationPath = join(observationDirectory, `${observationId}.json`);
    await atomicWrite(observationPath, `${JSON.stringify({
      ...metadata,
      observationId,
      sha256,
      mimeType: "image/png",
      byteLength: png.byteLength,
    })}\n`);
    return {
      uri: `godot-mcp://evidence/${sha256}`,
      observationUri: `godot-mcp://evidence/${sha256}/observations/${observationId}`,
      sha256,
      mimeType: "image/png",
      byteLength: png.byteLength,
      path,
      observationPath,
    };
  }

  async readSessionPngObservation(sessionId: string, observationUri: string): Promise<PngObservation> {
    validateSessionId(sessionId);
    const { sha256, observationId } = observationIdentity(observationUri);
    let directory: string;
    let observationDirectory: string;
    try {
      directory = await plainDirectory(this.projectRoot, [".godot", "evidence", "godot-mcp", "sessions", sessionId], false);
      observationDirectory = await plainDirectory(this.projectRoot, [".godot", "evidence", "godot-mcp", "sessions", sessionId, `${sha256}.observations`], false);
    } catch (error) {
      if (error instanceof GodotMcpException && error.code === "PRECONDITION_FAILED") {
        throw evidenceError("STALE_HANDLE", "Evidence observation does not belong to the current session");
      }
      throw error;
    }
    const observationPath = join(observationDirectory, `${observationId}.json`);
    const observationBytes = await readPlainFile(observationPath).catch((error: unknown) => {
      if (error instanceof GodotMcpException && error.code === "PRECONDITION_FAILED") {
        throw evidenceError("STALE_HANDLE", "Evidence observation does not belong to the current session");
      }
      throw error;
    });
    let metadata: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(observationBytes.toString("utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new TypeError("not an object");
      metadata = parsed as Record<string, unknown>;
    } catch {
      throw evidenceError("CONFLICT", "Evidence observation metadata is malformed");
    }
    if (
      metadata.observationId !== observationId ||
      metadata.sha256 !== sha256 ||
      metadata.mimeType !== "image/png" ||
      !Number.isInteger(metadata.byteLength) ||
      !Number.isInteger(metadata.width) || Number(metadata.width) < 1 || Number(metadata.width) > 2048 ||
      !Number.isInteger(metadata.height) || Number(metadata.height) < 1 || Number(metadata.height) > 2048
    ) throw evidenceError("CONFLICT", "Evidence observation metadata conflicts with its URI");
    const data = await readPlainFile(join(directory, `${sha256}.png`));
    const actualSha256 = createHash("sha256").update(data).digest("hex");
    if (actualSha256 !== sha256 || data.byteLength !== metadata.byteLength) {
      throw evidenceError("CONFLICT", "Evidence PNG digest or length conflicts with its observation");
    }
    return {
      data,
      sha256,
      mimeType: "image/png",
      byteLength: data.byteLength,
      width: Number(metadata.width),
      height: Number(metadata.height),
      observationUri: observationUri as `godot-mcp://evidence/${string}`,
    };
  }

  async putJson(sessionId: string, value: unknown, metadata: Record<string, unknown>): Promise<JsonEvidenceReference> {
    validateSessionId(sessionId);
    const contents = Buffer.from(canonicalJson(value), "utf8");
    if (contents.byteLength > MAX_JSON_BYTES) throw evidenceError("PAYLOAD_TOO_LARGE", "JSON evidence exceeds one MiB");
    const sha256 = createHash("sha256").update(contents).digest("hex");
    const directory = await plainDirectory(this.projectRoot, [".godot", "evidence", "godot-mcp", "sessions", sessionId], true);
    const path = join(directory, `${sha256}.json`);
    const existing = await readOptionalPlainFile(path);
    if (existing && !existing.equals(contents)) throw evidenceError("CONFLICT", "Existing JSON evidence digest conflicts");
    if (!existing) await atomicWrite(path, contents);
    const observationId = randomUUID();
    const observationDirectory = await plainDirectory(this.projectRoot, [".godot", "evidence", "godot-mcp", "sessions", sessionId, `${sha256}.observations`], true);
    const observationPath = join(observationDirectory, `${observationId}.json`);
    await atomicWrite(observationPath, `${canonicalJson({
      ...metadata,
      observationId,
      sha256,
      mimeType: "application/json",
      byteLength: contents.byteLength,
    })}\n`);
    return {
      uri: `godot-mcp://evidence/${sha256}`,
      observationUri: `godot-mcp://evidence/${sha256}/observations/${observationId}`,
      sha256,
      mimeType: "application/json",
      byteLength: contents.byteLength,
      path,
      observationPath,
    };
  }

  async createPngBaseline(
    sessionId: string,
    name: string,
    observationUri: string,
    createdAtUnixMs = Date.now(),
  ): Promise<PngBaselineManifest> {
    validateBaselineName(name);
    const observation = await this.readSessionPngObservation(sessionId, observationUri);
    const directory = await plainDirectory(this.projectRoot, [".godot", "evidence", "godot-mcp", "baselines", name], true);
    const manifestPath = join(directory, "manifest.json");
    const existingManifest = await readOptionalPlainFile(manifestPath);
    if (existingManifest) {
      let existing: PngBaselineManifest;
      try {
        existing = parsePngBaselineManifest(JSON.parse(existingManifest.toString("utf8")), name);
      } catch (error) {
        if (error instanceof GodotMcpException) throw error;
        throw evidenceError("CONFLICT", "Visual baseline manifest is malformed");
      }
      if (existing.sha256 !== observation.sha256) throw evidenceError("CONFLICT", "Visual baseline name already refers to different evidence");
      await this.readPngBaselineData(name);
      return existing;
    }
    const manifest: PngBaselineManifest = {
      schemaVersion: 1,
      comparisonContractVersion: 1,
      name,
      sha256: observation.sha256,
      mimeType: "image/png",
      byteLength: observation.byteLength,
      width: observation.width,
      height: observation.height,
      sourceObservationSha256: observation.sha256,
      createdAtUnixMs,
    };
    const pngPath = join(directory, `${observation.sha256}.png`);
    if (!(await readOptionalPlainFile(pngPath))) await atomicWrite(pngPath, observation.data);
    if (await atomicWriteOnce(manifestPath, `${canonicalJson(manifest)}\n`)) return manifest;
    const winner = await this.readPngBaselineData(name);
    if (winner.manifest.sha256 !== observation.sha256) {
      throw evidenceError("CONFLICT", "Visual baseline name already refers to different evidence");
    }
    return winner.manifest;
  }

  async readPngBaseline(name: string): Promise<PngBaselineManifest> {
    return (await this.readPngBaselineData(name)).manifest;
  }

  async readPngBaselineData(name: string): Promise<{ manifest: PngBaselineManifest; data: Uint8Array }> {
    validateBaselineName(name);
    const directory = await plainDirectory(this.projectRoot, [".godot", "evidence", "godot-mcp", "baselines", name], false);
    const manifestBytes = await readPlainFile(join(directory, "manifest.json"));
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestBytes.toString("utf8"));
    } catch {
      throw evidenceError("CONFLICT", "Visual baseline manifest is malformed");
    }
    const manifest = parsePngBaselineManifest(parsed, name);
    const data = await readPlainFile(join(directory, `${manifest.sha256}.png`));
    const digest = createHash("sha256").update(data).digest("hex");
    if (digest !== manifest.sha256 || data.byteLength !== manifest.byteLength) {
      throw evidenceError("CONFLICT", "Visual baseline bytes conflict with its manifest");
    }
    return { manifest, data };
  }
}
