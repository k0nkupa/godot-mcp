import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { discoverProject, ProjectConfigSchema } from "@godot-mcp/control-plane";

import { readInstallManifest, sha256 } from "./addonManifest.js";
import { godotVersion } from "./pluginState.js";

export interface DoctorCheck {
  name: "project-config" | "addon-manifest" | "addon-files" | "plugin-enabled" | "godot-version" | "runtime-state";
  status: "ok" | "warning" | "error";
  detail: string;
}

export interface DoctorReport {
  healthy: boolean;
  checks: DoctorCheck[];
}

export async function runDoctor(projectInput: string): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let root: string;
  try {
    root = (await discoverProject(projectInput)).rootRealPath;
  } catch (error) {
    return {
      healthy: false,
      checks: [{ name: "project-config", status: "error", detail: (error as Error).message }],
    };
  }

  try {
    ProjectConfigSchema.parse(JSON.parse(await readFile(join(root, ".godot-mcp.json"), "utf8")));
    checks.push({ name: "project-config", status: "ok", detail: "Project configuration is valid" });
  } catch {
    checks.push({ name: "project-config", status: "error", detail: "Project configuration is missing or invalid" });
  }

  let manifest;
  try {
    manifest = await readInstallManifest(root);
    checks.push({ name: "addon-manifest", status: "ok", detail: "Install manifest is valid" });
  } catch {
    checks.push({ name: "addon-manifest", status: "error", detail: "Install manifest is missing or invalid" });
  }

  if (manifest) {
    try {
      for (const file of manifest.files) {
        if (sha256(await readFile(join(root, file.relativePath))) !== file.sha256) {
          throw new Error(file.relativePath);
        }
      }
      checks.push({ name: "addon-files", status: "ok", detail: "Installed addon hashes match" });
    } catch (error) {
      checks.push({ name: "addon-files", status: "error", detail: `Installed addon hash mismatch: ${(error as Error).message}` });
    }
  } else {
    checks.push({ name: "addon-files", status: "error", detail: "Cannot verify files without a valid manifest" });
  }

  try {
    const projectFile = await readFile(join(root, "project.godot"), "utf8");
    const enabled = projectFile.includes('"res://addons/godot_mcp/plugin.cfg"');
    checks.push({
      name: "plugin-enabled",
      status: enabled ? "ok" : "error",
      detail: enabled ? "Godot MCP editor plugin is enabled" : "Godot MCP editor plugin is disabled",
    });
  } catch {
    checks.push({ name: "plugin-enabled", status: "error", detail: "Could not inspect project.godot" });
  }

  try {
    const version = await godotVersion();
    checks.push({ name: "godot-version", status: "ok", detail: version });
  } catch (error) {
    checks.push({ name: "godot-version", status: "error", detail: (error as Error).message });
  }

  try {
    const entries = await readdir(join(root, ".godot/godot-mcp/runtime"));
    checks.push({
      name: "runtime-state",
      status: entries.length === 0 ? "ok" : "warning",
      detail: entries.length === 0 ? "No stale runtime entries" : `${entries.length} runtime entries present`,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      checks.push({ name: "runtime-state", status: "ok", detail: "No runtime directory" });
    } else {
      checks.push({ name: "runtime-state", status: "error", detail: "Could not inspect runtime state" });
    }
  }

  return { healthy: checks.every((check) => check.status !== "error"), checks };
}
