import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  copyFixture,
  launchEditor,
  launchMcpClient,
  reserveLoopbackPort,
  reserveLoopbackPortInRange,
  runCli,
  runGodot,
  waitUntil,
} from "@godot-mcp/testkit";
import { expect, test } from "vitest";

function withFrameReference(value: string): { frameToken: string } {
  return { ["frameToken"]: value };
}

function withProfileReference(value: string): { jobToken: string } {
  return { ["jobToken"]: value };
}

test.skipIf(process.platform !== "darwin")(
  "Phase 7 debugs and profiles through published stdio with explicit runtime authorization",
  async () => {
    const project = await copyFixture();
    const previousRuntime = process.env.XDG_RUNTIME_DIR;
    const runtimeDirectory = join(project.root, "runtime");
    process.env.XDG_RUNTIME_DIR = runtimeDirectory;
    let editor: Awaited<ReturnType<typeof launchEditor>> | undefined;
    let client: Awaited<ReturnType<typeof launchMcpClient>> | undefined;
    let lastStructured: unknown;
    let runtimePid = -1;
    let editorPid = -1;
    let debugServerPort = -1;
    let dapPort = -1;
    try {
      const imported = await runGodot(["--headless", "--editor", "--path", project.root, "--import"]);
      expect(imported.exitCode, imported.stderr).toBe(0);
      expect((await runCli(["init", "--project", project.root])).exitCode).toBe(0);
      debugServerPort = await reserveLoopbackPort();
      dapPort = await reserveLoopbackPortInRange(1_024, 49_151);
      while (dapPort === debugServerPort) dapPort = await reserveLoopbackPortInRange(1_024, 49_151);
      editor = await launchEditor(project.root, { headless: true, debugServerPort, dapPort });
      editorPid = editor.pid;
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

      const source = await readFile(join(project.root, "debug/debug_fixture.gd"), "utf8");
      const breakpointLine = source.split("\n").findIndex((line) => line.includes("PHASE7_BREAKPOINT_INNER")) + 1;
      expect(breakpointLine).toBeGreaterThan(0);
      const launched = await call(client, { operation: "launch", scenePath: "res://debug/debug_fixture.tscn" });
      lastStructured = launched;
      const handle = (launched as { handle: { runId: string; generation: number }; root: { pid: number } }).handle;
      runtimePid = (launched as { root: { pid: number } }).root.pid;

      const set = await call(client, {
        operation: "debug_breakpoints_set", handle,
        breakpoints: [{ sourcePath: "res://debug/debug_fixture.gd", line: breakpointLine }],
      }) as { breakpoints: Array<{ verified: boolean }> };
      expect(set.breakpoints).toEqual([expect.objectContaining({ verified: true })]);
      await expect(call(client, { operation: "debug_wait", handle, afterSequence: 0, timeoutMs: 10_000 })).resolves.toMatchObject({ reason: "breakpoint" });
      const stack = await call(client, { operation: "debug_stack", handle, offset: 0, limit: 64 }) as { frames: Array<{ frameToken: string; name: string }> };
      const inner = stack.frames.find((frame) => frame.name === "_inner");
      expect(inner).toBeDefined();
      const watch = await call(client, {
        operation: "debug_watch", handle, ...withFrameReference(inner!.frameToken),
        selectors: [{ scope: "locals", path: ["player", "health"] }],
      }) as { watches: Array<{ status: string; variable?: { value: string } }> };
      expect(watch.watches).toEqual([expect.objectContaining({ status: "found", variable: expect.objectContaining({ value: expect.stringContaining("100") }) })]);
      await call(client, { operation: "debug_breakpoints_set", handle, breakpoints: [] });
      await call(client, { operation: "debug_continue", handle });

      const snapshot = await call(client, { operation: "monitor_snapshot", handle, groups: ["frame", "custom"] }) as { groups: Record<string, unknown> };
      expect(snapshot.groups).toMatchObject({ frame: expect.any(Object), custom: expect.any(Object) });
      const started = await call(client, {
        operation: "profile_start", handle, durationMs: 300, intervalFrames: 1,
        groups: ["frame", "custom"], retainRaw: true,
      }) as { jobToken: string };
      await waitUntil(async () => {
        const status = await call(client!, { operation: "profile_status", handle, ...withProfileReference(started.jobToken) }) as { state: string };
        return status.state !== "running";
      }, 5_000, 50);
      const completed = await call(client, { operation: "profile_result", handle, ...withProfileReference(started.jobToken) });
      expect(completed).toMatchObject({ state: "completed", evidence: { complete: true, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });

      const cancellable = await call(client, {
        operation: "profile_start", handle, durationMs: 30_000, intervalFrames: 1,
        groups: ["frame"], retainRaw: false,
      }) as { jobToken: string };
      await expect(call(client, { operation: "profile_cancel", handle, ...withProfileReference(cancellable.jobToken) })).resolves.toMatchObject({ state: "cancelled" });
      await expect(call(client, { operation: "profile_result", handle, ...withProfileReference(cancellable.jobToken) })).resolves.toMatchObject({ evidence: { complete: false, state: "cancelled" } });
      await expect(call(client, { operation: "stop", handle })).resolves.toMatchObject({ state: "stopped" });

      const audit = await readFile(join(project.root, ".godot/evidence/godot-mcp/audit.jsonl"), "utf8");
      expect(audit).toContain('"operation":"profile_result"');
      expect(audit).not.toContain("Phase7Player");
      expect(audit).not.toContain("Phase7/WorkloadTotal");

      await client.close(); client = undefined;
      await editor.close(); editor = undefined;
      expect((await runCli(["disable", "--project", project.root])).exitCode).toBe(0);
      expect((await runCli(["uninstall", "--project", project.root])).exitCode).toBe(0);
      expect(await project.diffFromOriginal()).toEqual([]);
      expect(await readdir(join(runtimeDirectory, "godot-mcp")).catch(() => [])).toEqual([]);
      if (process.env.GODOT_MCP_PHASE7_CLEANUP_RECORD) {
        await writeFile(process.env.GODOT_MCP_PHASE7_CLEANUP_RECORD, `${JSON.stringify({
          projectRoot: project.root,
          runtimeDirectory,
          pids: [runtimePid, editorPid].filter((pid) => pid > 0),
          ports: [debugServerPort, dapPort],
        })}\n`, "utf8");
      }
    } catch (error) {
      throw new Error(`${String(error)}\nLast structured:\n${JSON.stringify(lastStructured)}\nMCP stderr:\n${client?.stderr ?? ""}\nEditor output:\n${editor?.output ?? ""}`);
    } finally {
      await client?.close();
      await editor?.close();
      if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previousRuntime;
      await project.cleanup();
    }
  },
  90_000,
);

async function call(
  client: NonNullable<Awaited<ReturnType<typeof launchMcpClient>>>,
  argumentsValue: Record<string, unknown>,
): Promise<unknown> {
  const result = await client.callTool({ name: "godot_runtime", arguments: argumentsValue });
  const structured = result.structuredContent as { ok?: boolean; data?: unknown; error?: unknown } | undefined;
  expect(structured, JSON.stringify(structured)).toMatchObject({ ok: true });
  return structured?.data;
}
