import { connectStdio } from "@godot-mcp/mcp-server";

import { runDoctor } from "../install/doctor.js";
import { createRuntime } from "../runtime/createRuntime.js";

export async function connectProject(project: string): Promise<void> {
  const doctor = await runDoctor(project);
  if (!doctor.healthy) {
    throw new Error("Godot MCP installation is unhealthy; run godot-mcp doctor before connect");
  }
  const runtime = await createRuntime({ project });
  process.stderr.write(
    `Godot MCP waiting for project ${runtime.project.projectId} on loopback port ${runtime.bridge.port}\n`,
  );
  await connectStdio(runtime.mcp, () => runtime.close("stdio-closed"));
}
