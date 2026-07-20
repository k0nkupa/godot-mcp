import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { canonicalJson, PRODUCT_VERSION } from "@godot-mcp/protocol";

export interface InstalledFile {
  relativePath: string;
  sha256: string;
}

export interface InstallManifest {
  schemaVersion: 1;
  productVersion: string;
  installedAt: string;
  manifestSha256: string;
  files: InstalledFile[];
  projectFile: {
    preimageBase64: string;
    preimageSha256: string;
    postimageSha256: string;
  };
  projectConfig: {
    created: boolean;
    sha256: string;
  };
}

function supportedManifestVersion(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) return false;
  const parsed = value.split(".").map(Number); const current = PRODUCT_VERSION.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (parsed[index]! < current[index]!) return true;
    if (parsed[index]! > current[index]!) return false;
  }
  return true;
}

export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function manifestPath(projectRoot: string): string {
  return join(projectRoot, ".godot/godot-mcp/install-manifest.json");
}

export function hashFileEntries(files: InstalledFile[]): string {
  return sha256(canonicalJson(files));
}

function isInstalledFile(value: unknown): value is InstalledFile {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.relativePath === "string" &&
    record.relativePath.startsWith("addons/godot_mcp/") &&
    !record.relativePath.includes("\\") &&
    !record.relativePath.split("/").includes("..") &&
    record.relativePath.length <= 512 &&
    typeof record.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(record.sha256)
  );
}

export function parseInstallManifest(value: unknown): InstallManifest {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Install manifest must be an object");
  }
  const manifest = value as Partial<InstallManifest>;
  if (
    manifest.schemaVersion !== 1 ||
    !supportedManifestVersion(manifest.productVersion) ||
    typeof manifest.installedAt !== "string" ||
    !Number.isFinite(Date.parse(manifest.installedAt)) ||
    typeof manifest.manifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.manifestSha256) ||
    !Array.isArray(manifest.files) ||
    !manifest.files.every(isInstalledFile) ||
    typeof manifest.projectFile !== "object" ||
    manifest.projectFile === null ||
    typeof manifest.projectFile.preimageBase64 !== "string" ||
    typeof manifest.projectFile.preimageSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.projectFile.preimageSha256) ||
    typeof manifest.projectFile.postimageSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.projectFile.postimageSha256) ||
    typeof manifest.projectConfig !== "object" ||
    manifest.projectConfig === null ||
    typeof manifest.projectConfig.created !== "boolean" ||
    typeof manifest.projectConfig.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.projectConfig.sha256)
  ) {
    throw new TypeError("Install manifest has an invalid shape");
  }
  const files = [...manifest.files].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  if (files.some((file, index) => file.relativePath !== manifest.files?.[index]?.relativePath)) {
    throw new TypeError("Install manifest file entries are not sorted");
  }
  if (new Set(files.map((file) => file.relativePath)).size !== files.length) throw new TypeError("Install manifest file entries are not unique");
  if (hashFileEntries(files) !== manifest.manifestSha256) {
    throw new TypeError("Install manifest digest does not match its file entries");
  }
  return manifest as InstallManifest;
}

export async function readInstallManifest(projectRoot: string): Promise<InstallManifest> {
  return parseInstallManifest(JSON.parse(await readFile(manifestPath(projectRoot), "utf8")));
}

export async function writeInstallManifest(
  projectRoot: string,
  manifest: InstallManifest,
): Promise<void> {
  const path = manifestPath(projectRoot);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function updateProjectPostimage(projectRoot: string): Promise<void> {
  const manifest = await readInstallManifest(projectRoot);
  const projectContents = await readFile(join(projectRoot, "project.godot"));
  await writeInstallManifest(projectRoot, {
    ...manifest,
    projectFile: { ...manifest.projectFile, postimageSha256: sha256(projectContents) },
  });
}
