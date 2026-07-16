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
    if (pack !== "runtime") throw new Error(`Unsupported connect pack: ${pack}`);
  }
  if (normalizedGrants.includes("runtime_control") !== normalizedPacks.includes("runtime")) {
    throw new Error("runtime_control and runtime must be granted together");
  }
  return normalizedGrants.includes("runtime_control")
    ? { tiers: ["observe", "runtime_control"], packs: ["core", "runtime"] }
    : { tiers: ["observe"], packs: ["core"] };
}

export async function connectProject(
  project: string,
  grants: SessionGrants = parseConnectGrants([], []),
  godotBin?: string,
): Promise<void> {
  const doctor = await runDoctor(project);
  if (!doctor.healthy) {
    throw new Error("Godot MCP installation is unhealthy; run godot-mcp doctor before connect");
  }
  const runtime = await createRuntime({ project, grants, ...(godotBin === undefined ? {} : { godotBin }) });
  process.stderr.write(
    `Godot MCP waiting for project ${runtime.project.projectId} on loopback port ${runtime.bridge.port}\n`,
  );
  await connectStdio(runtime.mcp, () => runtime.close("stdio-closed"));
}
