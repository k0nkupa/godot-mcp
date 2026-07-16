import { connectStdio } from "@godot-mcp/mcp-server";
import type { SessionGrants } from "@godot-mcp/control-plane";

import { runDoctor } from "../install/doctor.js";
import { createRuntime } from "../runtime/createRuntime.js";

export function parseConnectGrants(grants: readonly string[], packs: readonly string[]): SessionGrants {
  const normalizedGrants = [...new Set(grants.flatMap((value) => value.split(",")).filter(Boolean))];
  const normalizedPacks = [...new Set(packs.flatMap((value) => value.split(",")).filter(Boolean))];
  for (const grant of normalizedGrants) {
    if (grant !== "runtime_control") throw new Error(`Unsupported connect grant: ${grant}`);
  }
  for (const pack of normalizedPacks) {
    if (pack !== "runtime" && pack !== "input") throw new Error(`Unsupported connect pack: ${pack}`);
  }
  const hasRuntimePack = normalizedPacks.includes("runtime") || normalizedPacks.includes("input");
  if (normalizedGrants.includes("runtime_control") !== hasRuntimePack) {
    throw new Error("runtime_control must be granted with runtime or input packs");
  }
  if (!hasRuntimePack) return { tiers: ["observe"], packs: ["core"] };
  return {
    tiers: ["observe", "runtime_control"],
    packs: ["core", ...(normalizedPacks.includes("runtime") ? ["runtime" as const] : []), ...(normalizedPacks.includes("input") ? ["input" as const] : [])],
  };
}

export async function connectProject(
  project: string,
  grants: SessionGrants = parseConnectGrants([], []),
  godotBin?: string,
): Promise<void> {
  const doctor = await runDoctor(project, godotBin);
  if (!doctor.healthy) {
    throw new Error("Godot MCP installation is unhealthy; run godot-mcp doctor before connect");
  }
  const runtime = await createRuntime({ project, grants, ...(godotBin === undefined ? {} : { godotBin }) });
  process.stderr.write(
    `Godot MCP waiting for project ${runtime.project.projectId} on loopback port ${runtime.bridge.port}\n`,
  );
  await connectStdio(runtime.mcp, () => runtime.close("stdio-closed"));
}
