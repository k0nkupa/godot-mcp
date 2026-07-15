import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { GodotMcpException } from "../errors.js";

const MAX_PNG_BYTES = 8 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const SESSION_PATTERN = /^session_[A-Za-z0-9_-]{8,128}$/;

export interface PngEvidenceMetadata {
  viewport: "2d" | "3d";
  width: number;
  height: number;
  viewportIndex?: number;
}

export interface EvidenceReference {
  uri: `godot-mcp://evidence/${string}`;
  sha256: string;
  mimeType: "image/png";
  byteLength: number;
  path: string;
}

function evidenceError(
  code: "PATH_DENIED" | "INVALID_REQUEST" | "PAYLOAD_TOO_LARGE" | "CONFLICT",
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

export class EvidenceStore {
  constructor(private readonly projectRoot: string) {}

  async putPng(
    sessionId: string,
    png: Uint8Array,
    metadata: PngEvidenceMetadata,
  ): Promise<EvidenceReference> {
    if (!SESSION_PATTERN.test(sessionId)) {
      throw evidenceError("PATH_DENIED", "Evidence session identifier is invalid");
    }
    if (png.byteLength > MAX_PNG_BYTES) {
      throw evidenceError("PAYLOAD_TOO_LARGE", "PNG evidence exceeds 8 MiB");
    }
    if (png.byteLength < PNG_SIGNATURE.length || !Buffer.from(png).subarray(0, 8).equals(PNG_SIGNATURE)) {
      throw evidenceError("INVALID_REQUEST", "Evidence bytes are not a PNG");
    }
    const sha256 = createHash("sha256").update(png).digest("hex");
    const directory = join(
      this.projectRoot,
      ".godot/evidence/godot-mcp/sessions",
      sessionId,
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${sha256}.png`);
    const existing = await readFile(path).catch(() => undefined);
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
      ...metadata,
    })}\n`;
    if (!(await readFile(metadataPath).catch(() => undefined))) {
      await atomicWrite(metadataPath, metadataContents);
    }
    return {
      uri: `godot-mcp://evidence/${sha256}`,
      sha256,
      mimeType: "image/png",
      byteLength: png.byteLength,
      path,
    };
  }
}
