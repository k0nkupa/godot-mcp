import { join } from "node:path";

import { copyFixture, launchEditor, launchMcpClient, reserveLoopbackPort, runCli, runGodot, waitUntil } from "@godot-mcp/testkit";
import { expect, test } from "vitest";

test.skipIf(process.platform !== "darwin")("Phase 9 operates a disposable project through published stdio", async () => {
  const project = await copyFixture();
  const previousRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = join(project.root, "runtime");
  let editor: Awaited<ReturnType<typeof launchEditor>> | undefined;
  let client: Awaited<ReturnType<typeof launchMcpClient>> | undefined;
  try {
    expect((await runGodot(["--headless", "--editor", "--path", project.root, "--import"])).exitCode).toBe(0);
    expect((await runCli(["init", "--project", project.root])).exitCode).toBe(0);
    const port = await reserveLoopbackPort();
    editor = await launchEditor(project.root, { headless: false, debugServerPort: port, dapPort: port });
    client = await launchMcpClient(["connect", "--project", project.root, "--grant", "project_operate", "--pack", "project"]);
    await waitUntil(async () => ((await client?.callTool({ name: "godot_session", arguments: {} })).structuredContent as { data?: { state?: string } })?.data?.state === "attached", 15_000, 100);
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "godot_capabilities", "godot_capture", "godot_doctor", "godot_help", "godot_project", "godot_query", "godot_session",
    ]);
    const key = crypto.randomUUID();
    await expect(callProject(client, { operation: "settings_apply", idempotencyKey: key, changes: [{ name: "application/config/name", expectedValue: "Godot MCP Fixture", value: "Phase 9 Fixture" }] })).resolves.toMatchObject({ operation: "settings_apply" });
    await expect(callProject(client, { operation: "settings_apply", idempotencyKey: key, changes: [{ name: "application/config/name", expectedValue: "Godot MCP Fixture", value: "Phase 9 Fixture" }] })).resolves.toMatchObject({ operation: "settings_apply" });
    const started = await callProject(client, { operation: "import_start", kind: "full", deadlineMs: 120_000 }) as { jobToken: string };
    await waitUntil(async () => ["completed", "failed", "cancelled"].includes(String((await callProject(client!, { operation: "job_status", jobToken: started.jobToken }) as { state: string }).state)), 120_000, 100);
    await expect(callProject(client, { operation: "job_result", jobToken: started.jobToken })).resolves.toMatchObject({ state: "completed", operation: "import" });
  } finally {
    await client?.close(); await editor?.close();
    if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = previousRuntime;
    await project.cleanup();
  }
}, 180_000);

async function callProject(client: NonNullable<Awaited<ReturnType<typeof launchMcpClient>>>, argumentsValue: Record<string, unknown>): Promise<unknown> {
  const result = await client.callTool({ name: "godot_project", arguments: argumentsValue });
  const structured = result.structuredContent as { ok?: boolean; data?: unknown };
  expect(structured, JSON.stringify(structured)).toMatchObject({ ok: true });
  return structured.data;
}
