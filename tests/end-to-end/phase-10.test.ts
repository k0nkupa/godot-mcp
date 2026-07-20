import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { copyFixture, launchEditor, launchMcpClient, reserveLoopbackPort, runCli, runGodot, waitUntil } from "@godot-mcp/testkit";
import { expect, test } from "vitest";

const confirmation = "I UNDERSTAND THIS RUNS UNSANDBOXED CODE";

test.skipIf(process.platform !== "darwin")("Phase 10 runs visibly unsandboxed code only in a registered disposable copy through stdio", async () => {
  const template = await copyFixture(); const container = await mkdtemp(join(tmpdir(), "godot-mcp-phase10-e2e-")); const copy = join(container, "copy"); const registry = join(container, "registry.json");
  let editor: Awaited<ReturnType<typeof launchEditor>> | undefined; let client: Awaited<ReturnType<typeof launchMcpClient>> | undefined;
  try {
    const registered = await runCli(["unsafe-register", "--project", template.root, "--registry", registry, "--confirmation", confirmation]); expect(registered.exitCode).toBe(0);
    const registrationId = (JSON.parse(registered.stdout) as { registrationId: string }).registrationId;
    await cp(template.root, copy, { recursive: true });
    expect((await runCli(["unsafe-stamp-copy", "--project", copy, "--registry", registry, "--registration", registrationId])).exitCode).toBe(0);
    const approved = await runCli(["unsafe-approve", "--project", copy, "--registry", registry, "--activation-dir", container, "--confirmation", confirmation, "--ttl-ms", "120000"]); expect(approved.exitCode).toBe(0);
    const leasePath = (JSON.parse(approved.stdout) as { leasePath: string }).leasePath;
    expect((await runCli(["init", "--project", copy])).exitCode).toBe(0);
    expect((await runGodot(["--headless", "--editor", "--path", copy, "--import"])).exitCode).toBe(0);
    const port = await reserveLoopbackPort(); editor = await launchEditor(copy, { headless: false, debugServerPort: port, dapPort: port });
    client = await launchMcpClient(["connect", "--project", copy, "--grant", "unsafe_fixture", "--pack", "unsafe", "--registry", registry, "--activation", leasePath]);
    await waitUntil(async () => ((await client?.callTool({ name: "godot_session", arguments: {} })).structuredContent as { data?: { state?: string } })?.data?.state === "attached", 15_000, 100);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("godot_unsafe_fixture");
    const started = await callUnsafe(client, { operation: "execute_start", source: 'extends SceneTree\nfunc _init():\n print("PHASE10_STDIO_UNSAFE_OK")\n quit()\n', deadlineMs: 5_000 }) as { jobToken: string };
    await waitUntil(async () => ["completed", "failed", "cancelled"].includes(String((await callUnsafe(client!, { operation: "job_status", jobToken: started.jobToken }) as { state: string }).state)), 10_000, 50);
    await expect(callUnsafe(client, { operation: "job_result", jobToken: started.jobToken })).resolves.toMatchObject({ state: "completed", unsafe: true, sandboxed: false, cleanup: "succeeded" });
  } finally { await client?.close(); await editor?.close(); await template.cleanup(); await rm(container, { recursive: true, force: true }); }
}, 120_000);

async function callUnsafe(client: NonNullable<Awaited<ReturnType<typeof launchMcpClient>>>, argumentsValue: Record<string, unknown>): Promise<unknown> {
  const result = await client.callTool({ name: "godot_unsafe_fixture", arguments: argumentsValue }); const structured = result.structuredContent as { ok?: boolean; data?: unknown }; expect(structured, JSON.stringify(structured)).toMatchObject({ ok: true }); return structured.data;
}
