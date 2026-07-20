import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { canonicalJson, ProjectArtifactManifestSchema, type ProjectArtifactManifest } from "@godot-mcp/protocol";

import { GodotMcpException } from "../errors.js";

const JOB_TOKEN_PATTERN = /^pjob_[A-Za-z0-9_-]{43}$/;
const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 64 * 1024;
const LEAK_MARKERS = [
  "addons/godot_mcp",
  "godot_mcp/runtime",
  "godot-mcp://",
  "runtime_harness.gd",
  "godot_mcp_unsafe",
  "godotmcpruntimeharness",
  "godotmcpbridgeclient",
  "godotmcpprojectoperations",
  "godot_mcp_runtime:hello",
  ".godot-mcp-unsafe-fixture",
] as const;

function artifactError(
  code: "PATH_DENIED" | "PRECONDITION_FAILED" | "CONFLICT" | "PAYLOAD_TOO_LARGE" | "EXPORT_LEAK_DETECTED",
  message: string,
): GodotMcpException {
  return new GodotMcpException({
    code,
    message,
    retryable: false,
    correlationId: randomUUID(),
    partialEffects: code === "EXPORT_LEAK_DETECTED",
    rollback: "not_needed",
  });
}

function validateIdentity(jobToken: string, artifactName?: string): void {
  if (!JOB_TOKEN_PATTERN.test(jobToken) || (artifactName !== undefined && !ARTIFACT_NAME_PATTERN.test(artifactName))) {
    throw artifactError("PATH_DENIED", "Artifact identity is invalid");
  }
}

async function ensurePlainDirectory(root: string, segments: string[], create: boolean): Promise<string> {
  let current = root;
  const rootMetadata = await lstat(current).catch(() => undefined);
  if (!rootMetadata || rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw artifactError("PATH_DENIED", "Artifact root must be a regular non-symlink directory");
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
    if (!metadata) throw artifactError("PRECONDITION_FAILED", "Artifact directory is unavailable");
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw artifactError("PATH_DENIED", "Artifact directories must not be symbolic links");
  }
  return current;
}

export interface ArtifactScanFinding {
  relativePath: string;
  marker: string;
}

export interface ArtifactScanEntry {
  relativePath: string;
  byteLength: number;
  sha256: string;
}

export interface ArtifactScanResult {
  leakFree: boolean;
  findings: ArtifactScanFinding[];
  entries: ArtifactScanEntry[];
  byteLength: number;
  sha256: string;
}

export interface ArtifactScanOptions {
  maxEntries?: number;
  maxBytes?: number;
  chunkBytes?: number;
}

export async function scanArtifactDirectory(directory: string, options: ArtifactScanOptions = {}): Promise<ArtifactScanResult> {
  const root = resolve(directory);
  const rootMetadata = await lstat(root).catch(() => undefined);
  if (!rootMetadata || rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw artifactError("PATH_DENIED", "Artifact scan root must be a regular non-symlink directory");
  }
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > DEFAULT_MAX_ENTRIES) throw artifactError("PAYLOAD_TOO_LARGE", "Artifact entry limit is invalid");
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_BYTES) throw artifactError("PAYLOAD_TOO_LARGE", "Artifact byte limit is invalid");
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > DEFAULT_CHUNK_BYTES) throw artifactError("PAYLOAD_TOO_LARGE", "Artifact scan chunk is invalid");

  const paths: string[] = [];
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw artifactError("PATH_DENIED", "Artifact trees may not contain symbolic links");
      if (metadata.isDirectory()) {
        await visit(path);
      } else if (metadata.isFile()) {
        paths.push(path);
        if (paths.length > maxEntries) throw artifactError("PAYLOAD_TOO_LARGE", "Artifact contains too many files");
      } else {
        throw artifactError("PATH_DENIED", "Artifact trees may contain only regular files and directories");
      }
    }
  }
  await visit(root);
  if (paths.length === 0) throw artifactError("PRECONDITION_FAILED", "Artifact directory is empty");

  const findings: ArtifactScanFinding[] = [];
  const entries: ArtifactScanEntry[] = [];
  let totalBytes = 0;
  const longestMarker = Math.max(...LEAK_MARKERS.map((marker) => marker.length));
  for (const path of paths.sort()) {
    const relativePath = relative(root, path).split(sep).join("/");
    if (relativePath.startsWith("../") || relativePath === "..") throw artifactError("PATH_DENIED", "Artifact path escaped its owned root");
    const pathLower = relativePath.toLowerCase();
    for (const marker of LEAK_MARKERS) {
      if (pathLower.includes(marker) && findings.length < 64) findings.push({ relativePath, marker });
    }
    const hash = createHash("sha256");
    let byteLength = 0;
    let tail = "";
    for await (const rawChunk of createReadStream(path, { highWaterMark: chunkBytes })) {
      const chunk = rawChunk as Buffer;
      hash.update(chunk);
      byteLength += chunk.byteLength;
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) throw artifactError("PAYLOAD_TOO_LARGE", "Artifact exceeds the scan byte limit");
      const text = `${tail}${chunk.toString("latin1").toLowerCase()}`;
      for (const marker of LEAK_MARKERS) {
        if (text.includes(marker) && findings.length < 64 && !findings.some((finding) => finding.relativePath === relativePath && finding.marker === marker)) {
          findings.push({ relativePath, marker });
        }
      }
      tail = text.slice(-(longestMarker - 1));
    }
    entries.push({ relativePath, byteLength, sha256: hash.digest("hex") });
  }
  const sha256 = createHash("sha256").update(canonicalJson(entries)).digest("hex");
  return { leakFree: findings.length === 0, findings, entries, byteLength: totalBytes, sha256 };
}

export class ArtifactStore {
  constructor(private readonly projectRoot: string) {}

  async allocate(jobToken: string, artifactName: string): Promise<{ path: string }> {
    validateIdentity(jobToken, artifactName);
    const parent = await ensurePlainDirectory(this.projectRoot, [".godot", "evidence", "godot-mcp", "artifacts"], true);
    const path = join(parent, jobToken);
    if (await lstat(path).catch(() => undefined)) throw artifactError("CONFLICT", "Artifact job directory already exists");
    await mkdir(path, { mode: 0o700 });
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw artifactError("PATH_DENIED", "Artifact job directory is invalid");
    return { path };
  }

  async finalize(jobToken: string, artifactName: string): Promise<ProjectArtifactManifest> {
    validateIdentity(jobToken, artifactName);
    const path = await ensurePlainDirectory(this.projectRoot, [".godot", "evidence", "godot-mcp", "artifacts", jobToken], false);
    const scan = await scanArtifactDirectory(path);
    if (!scan.leakFree) throw artifactError("EXPORT_LEAK_DETECTED", "Export artifact contains Godot MCP components");
    const sha256 = createHash("sha256").update(canonicalJson({ name: artifactName, entries: scan.entries })).digest("hex");
    return ProjectArtifactManifestSchema.parse({
      uri: `godot-mcp://artifact/${jobToken}/${sha256}`,
      name: artifactName,
      byteLength: scan.byteLength,
      sha256,
      entryCount: scan.entries.length,
      leakFree: true,
    });
  }
}
