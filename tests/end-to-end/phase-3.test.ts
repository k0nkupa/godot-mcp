import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  copyFixture,
  inspectPng,
  launchEditor,
  launchMcpClient,
  reserveLoopbackPort,
  runCli,
  runGodot,
  waitUntil,
} from "@godot-mcp/testkit";
import { expect, test } from "vitest";

async function preserveFailureReceipts(
  projectRoot: string,
  editorOutput: string,
  mcpStderr: string,
  lastStructured: unknown,
): Promise<void> {
  const directory = process.env.GODOT_MCP_FAILURE_ARTIFACT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await copyFile(
    join(projectRoot, ".godot/evidence/godot-mcp/audit.jsonl"),
    join(directory, "phase-3-end-to-end-audit.jsonl"),
  ).catch(() => undefined);
  const redact = (value: string): string => value
    .replace(/--godot-mcp-runtime-descriptor=\S+/g, "--godot-mcp-runtime-descriptor=[REDACTED]")
    .replace(/[A-Za-z0-9_-]{43}/g, "[REDACTED]");
  await writeFile(join(directory, "phase-3-end-to-end-editor.log"), redact(editorOutput), "utf8");
  await writeFile(join(directory, "phase-3-end-to-end-mcp-stderr.log"), redact(mcpStderr), "utf8");
  await writeFile(join(directory, "phase-3-end-to-end-receipt.json"), `${JSON.stringify(lastStructured ?? null)}\n`, "utf8");
}

function images(result: { content: unknown[] }): Buffer[] {
  return result.content.flatMap((block) => {
    if (typeof block !== "object" || block === null || (block as { type?: string }).type !== "image") return [];
    return [Buffer.from(String((block as { data?: unknown }).data ?? ""), "base64")];
  });
}

test.skipIf(process.platform !== "darwin")(
  "Phase 3 works through published stdio with explicit runtime authorization",
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
      ]);
      await waitUntil(async () => {
        const result = await client?.callTool({ name: "godot_session", arguments: {} });
        return (result?.structuredContent as { data?: { state?: string } } | undefined)?.data?.state === "attached";
      }, 15_000, 100);

      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        "godot_capabilities", "godot_capture", "godot_doctor", "godot_help",
        "godot_query", "godot_runtime", "godot_runtime_capture", "godot_session",
      ]);

      const launch = await client.callTool({
        name: "godot_runtime",
        arguments: { operation: "launch", scenePath: "res://runtime/runtime_fixture.tscn" },
      });
      lastStructured = launch.structuredContent;
      expect(launch.structuredContent).toMatchObject({ ok: true, data: { handle: { generation: 1 }, root: { pid: expect.any(Number) } } });
      const handle = (launch.structuredContent as { data: { handle: { runId: string; generation: number } } }).data.handle;

      const tree = await client.callTool({ name: "godot_runtime", arguments: { operation: "tree", handle } });
      lastStructured = tree.structuredContent;
      expect(tree.structuredContent).toMatchObject({ ok: true, data: { nodes: expect.arrayContaining([expect.objectContaining({ nodePath: "Nested/Marker" })]) } });
      await expect(client.callTool({ name: "godot_runtime", arguments: { operation: "wait", handle, condition: { type: "property_equals", nodePath: ".", property: "phase", value: "ready" } } })).resolves.toMatchObject({ structuredContent: { ok: true } });

      const active = await client.callTool({ name: "godot_runtime_capture", arguments: { handle, maxWidth: 640, maxHeight: 360, frameCount: 2, intervalFrames: 2 } });
      lastStructured = active.structuredContent;
      const activeImages = images(active);
      expect(activeImages).toHaveLength(2);
      expect(createHash("sha256").update(activeImages[0]!).digest("hex")).not.toBe(createHash("sha256").update(activeImages[1]!).digest("hex"));
      for (const png of activeImages) {
        const inspected = inspectPng(png);
        expect(inspected.width).toBeLessThanOrEqual(640);
        expect(inspected.height).toBeLessThanOrEqual(360);
      }

      await client.callTool({ name: "godot_runtime", arguments: { operation: "pause", handle } });
      const paused = await client.callTool({ name: "godot_runtime_capture", arguments: { handle, maxWidth: 640, maxHeight: 360, frameCount: 2, intervalFrames: 2 } });
      const pausedImages = images(paused);
      expect(pausedImages).toHaveLength(2);
      expect(pausedImages[0]).toEqual(pausedImages[1]);
      await client.callTool({ name: "godot_runtime", arguments: { operation: "step", handle, frames: 2 } });
      await client.callTool({ name: "godot_runtime", arguments: { operation: "resume", handle } });
      const stopped = await client.callTool({ name: "godot_runtime", arguments: { operation: "stop", handle } });
      lastStructured = stopped.structuredContent;
      expect(stopped.structuredContent).toMatchObject({ ok: true, data: { state: "stopped" } });

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
      throw new Error(`${String(error)}\nLast structured:\n${JSON.stringify(lastStructured)}\nMCP stderr:\n${client?.stderr ?? ""}\nEditor output:\n${editor?.output ?? ""}`);
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
