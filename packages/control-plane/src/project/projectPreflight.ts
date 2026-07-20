import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { GodotMcpException } from "../errors.js";

function denied(message: string): GodotMcpException {
  return new GodotMcpException({ code: "CONFLICT", message, retryable: false, correlationId: "project-preflight", partialEffects: false, rollback: "not_needed" });
}

async function containedRegularFile(projectRoot: string, relativePath: string): Promise<string> {
  const root = await realpath(projectRoot);
  const path = resolve(root, relativePath);
  if (!path.startsWith(`${root}${sep}`)) throw denied("Project preflight path escaped the project");
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw denied("Project preflight input is not a regular file");
  return path;
}

export async function assertBuildSolutionsPreflight(projectRoot: string): Promise<void> {
  const entries = await readdir(projectRoot, { withFileTypes: true });
  if (!entries.some((entry) => entry.isFile() && (entry.name.endsWith(".sln") || entry.name.endsWith(".csproj")))) {
    throw denied("Build solutions requires a top-level .sln or .csproj file");
  }
}

export async function assertExportPreflight(projectRoot: string, presetName: string): Promise<void> {
  let text: string;
  try { text = await readFile(await containedRegularFile(projectRoot, "export_presets.cfg"), "utf8"); }
  catch (error) {
    if (error instanceof GodotMcpException) throw error;
    throw denied("Export requires export_presets.cfg");
  }
  if (Buffer.byteLength(text) > 1024 * 1024) throw denied("Export preset file exceeds 1 MiB");
  const sections = text.split(/^\[preset\.\d+\]\s*$/mu).slice(1);
  const section = sections.find((candidate) => candidate.match(/^name="(.*)"$/mu)?.[1] === presetName);
  if (!section) throw denied("Selected export preset does not exist");
  const excludes = section.match(/^exclude_filter="(.*)"$/mu)?.[1]?.split(",").map((value) => value.trim()) ?? [];
  if (!excludes.some((value) => value === "addons/godot_mcp/**" || value === "addons/godot_mcp/*")) {
    throw denied("Export preset must exclude addons/godot_mcp/**");
  }
}

export async function projectOperationPreflight(projectRoot: string, input: { operation: string; preset?: string }): Promise<void> {
  if (input.operation === "build_start") await assertBuildSolutionsPreflight(projectRoot);
  if (input.operation === "export_start") await assertExportPreflight(projectRoot, input.preset ?? "");
}
