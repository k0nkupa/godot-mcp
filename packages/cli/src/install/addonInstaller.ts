import { randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import {
  createProjectConfig,
  discoverProject,
  GodotMcpException,
} from "@godot-mcp/control-plane";
import { PRODUCT_VERSION } from "@godot-mcp/protocol";

import {
  hashFileEntries,
  manifestPath,
  readInstallManifest,
  sha256,
  type InstallManifest,
  type InstalledFile,
  writeInstallManifest,
} from "./addonManifest.js";

export interface InstallAddonResult {
  projectRoot: string;
  manifest: InstallManifest;
}

function conflict(message: string): GodotMcpException {
  return new GodotMcpException({
    code: "CONFLICT",
    message,
    retryable: false,
    correlationId: randomUUID(),
    partialEffects: false,
    rollback: "not_attempted",
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        files.push(relative(root, absolute));
      } else {
        throw conflict(`Addon source contains a non-regular entry: ${absolute}`);
      }
    }
  }
  await visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

async function installedTreeFiles(root: string): Promise<string[]> {
  if (!(await exists(root))) return [];
  return sourceFiles(root);
}

async function atomicWrite(path: string, contents: Uint8Array): Promise<void> {
  const temporary = `${path}.godot-mcp-${randomUUID()}`;
  await writeFile(temporary, contents);
  await rename(temporary, path);
}

async function verifyInstalledTree(projectRoot: string, manifest: InstallManifest): Promise<void> {
  const destinationRoot = join(projectRoot, "addons/godot_mcp");
  const expectedRelative = manifest.files.map((file) =>
    file.relativePath.slice("addons/godot_mcp/".length),
  );
  const actualRelative = await installedTreeFiles(destinationRoot);
  if (JSON.stringify(actualRelative) !== JSON.stringify(expectedRelative)) {
    throw conflict("Installed addon tree contains missing or untracked files");
  }
  for (const file of manifest.files) {
    const current = await readFile(join(projectRoot, file.relativePath));
    if (sha256(current) !== file.sha256) {
      throw conflict(`Installed addon file was modified: ${file.relativePath}`);
    }
  }
}

async function stageAddon(sourceRoot: string, temporaryRoot: string): Promise<InstalledFile[]> {
  const sourceMetadata = await lstat(sourceRoot);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw conflict("Addon source must be a regular directory");
  }
  const files = await sourceFiles(sourceRoot);
  if (files.length === 0) throw conflict("Addon source contains no files");
  await mkdir(temporaryRoot, { recursive: false, mode: 0o700 });
  const entries: InstalledFile[] = [];
  for (const sourceRelativePath of files) {
    const sourcePath = join(sourceRoot, sourceRelativePath);
    const temporaryPath = join(temporaryRoot, sourceRelativePath);
    await mkdir(dirname(temporaryPath), { recursive: true, mode: 0o700 });
    await copyFile(sourcePath, temporaryPath);
    const digest = sha256(await readFile(temporaryPath));
    if (digest !== sha256(await readFile(sourcePath))) {
      throw conflict(`Copied addon file failed hash verification: ${sourceRelativePath}`);
    }
    entries.push({
      relativePath: join("addons/godot_mcp", sourceRelativePath).replaceAll("\\", "/"),
      sha256: digest,
    });
  }
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export async function installAddon(
  projectInput: string,
  sourceInput: string,
): Promise<InstallAddonResult> {
  const project = await discoverProject(projectInput);
  const sourceRoot = resolve(sourceInput);
  const destinationRoot = join(project.rootRealPath, "addons/godot_mcp");
  const addonsRoot = dirname(destinationRoot);
  const temporaryRoot = join(addonsRoot, `.godot_mcp.tmp-${randomUUID()}`);
  const configPath = join(project.rootRealPath, ".godot-mcp.json");

  if (await exists(destinationRoot)) throw conflict("Godot MCP addon destination already exists");
  if (await exists(manifestPath(project.rootRealPath))) throw conflict("Godot MCP install manifest already exists");

  const projectPreimage = await readFile(project.projectFileRealPath);
  const configCreated = !(await exists(configPath));
  await createProjectConfig(project.rootRealPath);
  const configContents = await readFile(configPath);

  try {
    await mkdir(addonsRoot, { recursive: true, mode: 0o700 });
    const entries = await stageAddon(sourceRoot, temporaryRoot);
    await rename(temporaryRoot, destinationRoot);

    const projectDigest = sha256(projectPreimage);
    const manifest: InstallManifest = {
      schemaVersion: 1,
      productVersion: PRODUCT_VERSION,
      installedAt: new Date().toISOString(),
      manifestSha256: hashFileEntries(entries),
      files: entries,
      projectFile: {
        preimageBase64: projectPreimage.toString("base64"),
        preimageSha256: projectDigest,
        postimageSha256: projectDigest,
      },
      projectConfig: { created: configCreated, sha256: sha256(configContents) },
    };
    await writeInstallManifest(project.rootRealPath, manifest);
    return { projectRoot: project.rootRealPath, manifest };
  } catch (error) {
    await rm(temporaryRoot, { force: true, recursive: true });
    await rm(destinationRoot, { force: true, recursive: true });
    if (configCreated && (await exists(configPath))) {
      const currentConfig = await readFile(configPath);
      if (sha256(currentConfig) === sha256(configContents)) await rm(configPath, { force: true });
    }
    throw error;
  }
}

export async function upgradeAddon(
  projectInput: string,
  sourceInput: string,
): Promise<InstallAddonResult> {
  const project = await discoverProject(projectInput);
  const oldManifest = await readInstallManifest(project.rootRealPath).catch(() => {
    throw conflict("Godot MCP install manifest is missing or invalid");
  });
  await verifyInstalledTree(project.rootRealPath, oldManifest);

  const projectPath = join(project.rootRealPath, "project.godot");
  const configPath = join(project.rootRealPath, ".godot-mcp.json");
  if (sha256(await readFile(projectPath)) !== oldManifest.projectFile.postimageSha256) {
    throw conflict("project.godot changed independently after Godot MCP installation");
  }
  if (sha256(await readFile(configPath)) !== oldManifest.projectConfig.sha256) {
    throw conflict(".godot-mcp.json changed independently after Godot MCP installation");
  }

  const addonsRoot = join(project.rootRealPath, "addons");
  const destinationRoot = join(addonsRoot, "godot_mcp");
  const transactionId = randomUUID();
  const temporaryRoot = join(addonsRoot, `.godot_mcp.upgrade-${transactionId}`);
  const backupRoot = join(addonsRoot, `.godot_mcp.rollback-${transactionId}`);
  let switched = false;
  try {
    const entries = await stageAddon(resolve(sourceInput), temporaryRoot);
    const manifest: InstallManifest = {
      ...oldManifest,
      productVersion: PRODUCT_VERSION,
      installedAt: new Date().toISOString(),
      manifestSha256: hashFileEntries(entries),
      files: entries,
    };
    await rename(destinationRoot, backupRoot);
    try {
      await rename(temporaryRoot, destinationRoot);
    } catch (error) {
      await rename(backupRoot, destinationRoot);
      throw error;
    }
    switched = true;
    await writeInstallManifest(project.rootRealPath, manifest);
    await rm(backupRoot, { recursive: true });
    return { projectRoot: project.rootRealPath, manifest };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    if (switched) {
      await rm(destinationRoot, { recursive: true, force: true });
      await rename(backupRoot, destinationRoot);
      await writeInstallManifest(project.rootRealPath, oldManifest);
    }
    throw error;
  }
}

export async function uninstallAddon(projectInput: string): Promise<void> {
  const project = await discoverProject(projectInput);
  let manifest: InstallManifest;
  try {
    manifest = await readInstallManifest(project.rootRealPath);
  } catch {
    throw conflict("Godot MCP install manifest is missing or invalid");
  }

  const destinationRoot = join(project.rootRealPath, "addons/godot_mcp");
  await verifyInstalledTree(project.rootRealPath, manifest);

  const projectPath = join(project.rootRealPath, "project.godot");
  if (sha256(await readFile(projectPath)) !== manifest.projectFile.postimageSha256) {
    throw conflict("project.godot changed independently after Godot MCP installation");
  }
  const configPath = join(project.rootRealPath, ".godot-mcp.json");
  if (sha256(await readFile(configPath)) !== manifest.projectConfig.sha256) {
    throw conflict(".godot-mcp.json changed independently after Godot MCP installation");
  }

  await rm(destinationRoot, { recursive: true });
  await atomicWrite(projectPath, Buffer.from(manifest.projectFile.preimageBase64, "base64"));
  if (manifest.projectConfig.created) await rm(configPath);
  await rm(manifestPath(project.rootRealPath));
}
