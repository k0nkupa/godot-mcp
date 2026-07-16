import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  copyFixture,
  launchEditor,
  launchMcpClient,
  reserveLoopbackPort,
  runCli,
  runGodot,
  waitUntil,
} from "@godot-mcp/testkit";
import { expect, test } from "vitest";

function sanitizeFailureValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeFailureValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    ["trace", "event", "action", "keycode", "position"].includes(key) ? "[redacted]" : sanitizeFailureValue(child),
  ]));
}

async function preserveFailureReceipts(projectRoot: string, editorOutput: string, mcpStderr: string, lastStructured: unknown): Promise<void> {
  const directory = process.env.GODOT_MCP_FAILURE_ARTIFACT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await copyFile(join(projectRoot, ".godot/evidence/godot-mcp/audit.jsonl"), join(directory, "phase-4-end-to-end-audit.jsonl")).catch(() => undefined);
  const redact = (value: string): string => value
    .replace(/--godot-mcp-runtime-descriptor=\S+/g, "--godot-mcp-runtime-descriptor=[REDACTED]")
    .replace(/[A-Za-z0-9_-]{43}/g, "[REDACTED]")
    .replace(/phase_4_accept/g, "[REDACTED_ACTION]")
    .replace(/"keycode"\s*:\s*\d+/g, '"keycode":"[REDACTED]"');
  await writeFile(join(directory, "phase-4-end-to-end-editor.log"), redact(editorOutput), "utf8");
  await writeFile(join(directory, "phase-4-end-to-end-mcp-stderr.log"), redact(mcpStderr), "utf8");
  await writeFile(join(directory, "phase-4-end-to-end-receipt.json"), `${JSON.stringify(sanitizeFailureValue(lastStructured))}\n`, "utf8");
}

test.skipIf(process.platform !== "darwin")(
  "Phase 4 works through published stdio with explicit input authorization",
  async () => {
    const project = await copyFixture();
    const originalRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = join(project.root, "runtime");
    let editor: Awaited<ReturnType<typeof launchEditor>> | undefined;
    let client: Awaited<ReturnType<typeof launchMcpClient>> | undefined;
    let lastStructured: unknown;
    try {
      const imported = await runGodot(["--headless", "--editor", "--path", project.root, "--import"]);
      expect(imported.exitCode, imported.stderr).toBe(0);
      expect((await runCli(["init", "--project", project.root])).exitCode).toBe(0);

      const debugServerPort = await reserveLoopbackPort();
      editor = await launchEditor(project.root, { headless: true, debugServerPort });
      client = await launchMcpClient([
        "connect", "--project", project.root,
        "--grant", "runtime_control",
        "--pack", "runtime",
        "--pack", "input",
      ]);
      await waitUntil(async () => {
        const result = await client?.callTool({ name: "godot_session", arguments: {} });
        return (result?.structuredContent as { data?: { state?: string } } | undefined)?.data?.state === "attached";
      }, 15_000, 100);

      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        "godot_capabilities", "godot_capture", "godot_doctor", "godot_help", "godot_input",
        "godot_query", "godot_runtime", "godot_runtime_capture", "godot_session",
      ]);

      const launch = await client.callTool({ name: "godot_runtime", arguments: { operation: "launch", scenePath: "res://input/input_fixture.tscn" } });
      lastStructured = launch.structuredContent;
      expect(launch.structuredContent).toMatchObject({ ok: true, data: { handle: { generation: 1 } } });
      const handle = (launch.structuredContent as { data: { handle: { runId: string; generation: number } } }).data.handle;

      await client.callTool({ name: "godot_input", arguments: { operation: "record_start", handle } });
      const sequence = await client.callTool({
        name: "godot_input",
        arguments: {
          operation: "sequence",
          handle,
          mode: "realtime",
          events: [
            { frameOffset: 0, event: { type: "action", action: "phase_4_accept", pressed: true } },
            { frameOffset: 1, event: { type: "key", keycode: 67, pressed: true } },
            { frameOffset: 2, event: { type: "action", action: "phase_4_accept", pressed: false, strengthMillionths: 0 } },
          ],
        },
      });
      lastStructured = sequence.structuredContent;
      expect(sequence.structuredContent).toMatchObject({ ok: true, data: { receipt: { eventCount: 3, deliveredCount: 3, deterministic: false } } });
      const recorded = await client.callTool({ name: "godot_input", arguments: { operation: "record_stop", handle } });
      lastStructured = recorded.structuredContent;
      expect(recorded.structuredContent).toMatchObject({ ok: true, data: { receipt: { eventCount: 3 }, trace: { schemaVersion: 1, events: expect.any(Array) } } });
      const trace = (recorded.structuredContent as { data: { trace: unknown } }).data.trace;

      const firstNode = await client.callTool({ name: "godot_runtime", arguments: { operation: "node", handle, nodePath: ".", includeProperties: true, includeSignals: false } });
      const firstProperties = (firstNode.structuredContent as { data: { properties: Array<{ name: string; value: unknown }> } }).data.properties;
      const firstDigest = firstProperties.find((entry) => entry.name === "state_digest")?.value;
      expect(firstProperties.find((entry) => entry.name === "delivery_order")?.value).toBe("action,key,action");

      await client.callTool({ name: "godot_input", arguments: { operation: "send", handle, event: { type: "key", keycode: 82, pressed: true } } });
      await waitUntil(async () => {
        const result = await client?.callTool({ name: "godot_runtime", arguments: { operation: "node", handle, nodePath: ".", includeProperties: true, includeSignals: false } });
        const properties = (result?.structuredContent as { data?: { properties?: Array<{ name: string; value: unknown }> } } | undefined)?.data?.properties ?? [];
        const property = (name: string) => properties.find((entry) => entry.name === name)?.value;
        return property("event_count") === 0 && Number(property("frame_counter")) > 0;
      }, 5_000, 50);

      await client.callTool({ name: "godot_runtime", arguments: { operation: "pause", handle } });
      const replay = await client.callTool({ name: "godot_input", arguments: { operation: "replay", handle, trace } });
      lastStructured = replay.structuredContent;
      expect(replay.structuredContent).toMatchObject({ ok: true, data: { receipt: { deterministic: true, deliveredCount: 3 } } });
      const replayedNode = await client.callTool({ name: "godot_runtime", arguments: { operation: "node", handle, nodePath: ".", includeProperties: true, includeSignals: false } });
      const replayedProperties = (replayedNode.structuredContent as { data: { properties: Array<{ name: string; value: unknown }> } }).data.properties;
      expect(replayedProperties.find((entry) => entry.name === "state_digest")?.value).toBe(firstDigest);
      expect(replayedProperties.find((entry) => entry.name === "delivery_order")?.value).toBe("action,key,action");

      const audit = await readFile(join(project.root, ".godot/evidence/godot-mcp/audit.jsonl"), "utf8");
      expect(audit).not.toContain("phase_4_accept");
      expect(audit).not.toContain('"keycode":67');
      expect(audit).toContain('"eventKinds":{"action":2,"key":1}');

      await client.callTool({ name: "godot_runtime", arguments: { operation: "resume", handle } });
      const stopped = await client.callTool({ name: "godot_runtime", arguments: { operation: "stop", handle } });
      if ((stopped.structuredContent as { ok?: boolean } | undefined)?.ok) {
        expect(stopped.structuredContent).toMatchObject({ data: { state: "stopped" } });
      } else {
        const status = await client.callTool({ name: "godot_runtime", arguments: { operation: "status" } });
        expect(status.structuredContent).toMatchObject({ ok: true, data: { state: "stopped" } });
      }

      await client.close();
      client = undefined;
      await editor.close();
      editor = undefined;
      expect((await runCli(["disable", "--project", project.root])).exitCode).toBe(0);
      const uninstalled = await runCli(["uninstall", "--project", project.root]);
      expect(uninstalled.exitCode, uninstalled.stderr).toBe(0);
      expect(await project.diffFromOriginal()).toEqual([]);
      expect(await readdir(join(project.root, "runtime/godot-mcp")).catch(() => [])).toEqual([]);
    } catch (error) {
      await preserveFailureReceipts(project.root, editor?.output ?? "", client?.stderr ?? "", lastStructured);
      throw new Error(`${String(error)}\nLast structured:\n${JSON.stringify(sanitizeFailureValue(lastStructured))}\nMCP stderr:\n${client?.stderr ?? ""}\nEditor output:\n${editor?.output ?? ""}`);
    } finally {
      await client?.close();
      await editor?.close();
      if (originalRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = originalRuntimeDirectory;
      await project.cleanup();
    }
  },
  60_000,
);
