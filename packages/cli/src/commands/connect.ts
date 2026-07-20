import { connectStdio } from "@godot-mcp/mcp-server";
import { ExtensionRegistry, type SessionGrants } from "@godot-mcp/control-plane";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { runDoctor } from "../install/doctor.js";
import { createRuntime } from "../runtime/createRuntime.js";

export function parseConnectGrants(grants: readonly string[], packs: readonly string[]): SessionGrants {
  const normalizedGrants = [...new Set(grants.flatMap((value) => value.split(",")).filter(Boolean))];
  const normalizedPacks = [...new Set(packs.flatMap((value) => value.split(",")).filter(Boolean))];
  for (const grant of normalizedGrants) {
    if (grant !== "runtime_control" && grant !== "project_mutate" && grant !== "project_operate" && grant !== "unsafe_fixture") throw new Error(`Unsupported connect grant: ${grant}`);
  }
  for (const pack of normalizedPacks) {
    if (pack !== "runtime" && pack !== "input" && pack !== "editor" && pack !== "visual" && pack !== "project" && pack !== "unsafe") throw new Error(`Unsupported connect pack: ${pack}`);
  }
  const hasRuntimePack = normalizedPacks.includes("runtime") || normalizedPacks.includes("input");
  if (normalizedGrants.includes("runtime_control") !== hasRuntimePack) {
    throw new Error("runtime_control must be granted with runtime or input packs");
  }
  const hasEditorPack = normalizedPacks.includes("editor");
  if (normalizedGrants.includes("project_mutate") !== hasEditorPack) {
    throw new Error("project_mutate must be granted with the editor pack");
  }
  if (normalizedPacks.includes("visual") && (!normalizedPacks.includes("runtime") || !normalizedPacks.includes("input"))) throw new Error("visual requires runtime and input packs");
  const hasProjectPack = normalizedPacks.includes("project");
  if (normalizedGrants.includes("project_operate") !== hasProjectPack) throw new Error("project_operate must be granted with the project pack");
  const hasUnsafePack = normalizedPacks.includes("unsafe");
  if (normalizedGrants.includes("unsafe_fixture") !== hasUnsafePack) throw new Error("unsafe_fixture must be granted with the unsafe pack");
  if (!hasRuntimePack && !hasEditorPack && !hasProjectPack && !hasUnsafePack) return { tiers: ["observe"], packs: ["core"] };
  return {
    tiers: [
      "observe",
      ...(normalizedGrants.includes("runtime_control") ? ["runtime_control" as const] : []),
      ...(normalizedGrants.includes("project_mutate") ? ["project_mutate" as const] : []),
      ...(normalizedGrants.includes("project_operate") ? ["project_operate" as const] : []),
      ...(normalizedGrants.includes("unsafe_fixture") ? ["unsafe_fixture" as const] : []),
    ],
    packs: [
      "core",
      ...(normalizedPacks.includes("runtime") ? ["runtime" as const] : []),
      ...(normalizedPacks.includes("input") ? ["input" as const] : []),
      ...(normalizedPacks.includes("editor") ? ["editor" as const] : []),
      ...(normalizedPacks.includes("visual") ? ["visual" as const] : []),
      ...(normalizedPacks.includes("project") ? ["project" as const] : []),
      ...(normalizedPacks.includes("unsafe") ? ["unsafe" as const] : []),
    ],
  };
}

export async function connectProject(
  project: string,
  grants: SessionGrants = parseConnectGrants([], []),
  godotBin?: string,
  unsafeActivation?: { registryPath: string; leasePath: string },
  extensionModules: readonly string[] = [],
): Promise<void> {
  const doctor = await runDoctor(project, godotBin);
  if (!doctor.healthy) {
    throw new Error("Godot MCP installation is unhealthy; run godot-mcp doctor before connect");
  }
  const extensions = new ExtensionRegistry();
  for (const modulePath of extensionModules) {
    const module = await import(pathToFileURL(resolve(modulePath)).href) as { registerGodotMcpExtension?: (registry: ExtensionRegistry) => void | Promise<void> };
    if (typeof module.registerGodotMcpExtension !== "function") throw new Error(`Extension module does not export registerGodotMcpExtension: ${modulePath}`);
    await module.registerGodotMcpExtension(extensions);
  }
  const runtime = await createRuntime({ project, grants, ...(godotBin === undefined ? {} : { godotBin }), ...(unsafeActivation === undefined ? {} : { unsafeRegistryPath: unsafeActivation.registryPath, unsafeActivationPath: unsafeActivation.leasePath }), ...(extensionModules.length === 0 ? {} : { extensions }) });
  process.stderr.write(
    `Godot MCP waiting for project ${runtime.project.projectId} on loopback port ${runtime.bridge.port}\n`,
  );
  await connectStdio(runtime.mcp, () => runtime.close("stdio-closed"));
}
