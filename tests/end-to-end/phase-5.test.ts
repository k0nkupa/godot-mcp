import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { copyFixture, launchEditor, launchMcpClient, runCli, runGodot, waitUntil } from "@godot-mcp/testkit";
import { expect, test } from "vitest";

const scene = "res://mutation/editor_mutation.tscn";

test.skipIf(process.platform !== "darwin")(
  "Phase 5 works through published stdio with explicit editor authorization",
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
      editor = await launchEditor(project.root, { headless: true, scene });
      const connect = async () => {
        const next = await launchMcpClient([
          "connect", "--project", project.root,
          "--grant", "project_mutate", "--pack", "editor",
        ]);
        await waitUntil(async () => {
          const result = await next.callTool({ name: "godot_session", arguments: {} });
          return (result.structuredContent as { data?: { state?: string } } | undefined)?.data?.state === "attached";
        }, 15_000, 100);
        return next;
      };
      client = await connect();
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        "godot_capabilities", "godot_capture", "godot_doctor", "godot_editor", "godot_help", "godot_query", "godot_session",
      ]);
      const steps = [
        { operation: "set_property", scenePath: scene, nodePath: "Target", property: "position", value: { type: "vector2", x: 21, y: 34 } },
        { operation: "set_metadata", scenePath: scene, nodePath: "Target", key: "phase_5_stdio", value: "sensitive-fixture-value" },
        { operation: "add_group", scenePath: scene, nodePath: "Target", group: "phase_5_stdio", persistent: true },
        { operation: "create_node", scenePath: scene, parentPath: "Container", className: "Node2D", name: "StdioCreated" },
      ];
      const preview = await client.callTool({ name: "godot_editor", arguments: { operation: "preview", steps } });
      lastStructured = preview.structuredContent;
      expect(preview.structuredContent).toMatchObject({ ok: true, data: { state: "previewed", planDigest: expect.any(String) } });
      const planDigest = (preview.structuredContent as { data: { planDigest: string } }).data.planDigest;
      const idempotencyKey = randomUUID();
      const applyArguments = { operation: "apply", idempotencyKey, expectedPlanDigest: planDigest, steps };
      const applied = await client.callTool({ name: "godot_editor", arguments: applyArguments });
      lastStructured = applied.structuredContent;
      expect(applied.structuredContent).toMatchObject({ ok: true, data: { state: "applied", actionId: expect.any(String) } });
      const appliedData = (applied.structuredContent as { data: { actionId: string; planDigest: string } }).data;
      const postNode = await client.callTool({ name: "godot_query", arguments: { operation: "node", scenePath: scene, nodePath: "Target", includeProperties: true } });
      expect(JSON.stringify(postNode.structuredContent)).toContain("phase_5_stdio");
      await client.close();
      client = undefined;
	  await waitUntil(async () => {
		const entries = await readdir(join(project.root, "runtime/godot-mcp"), { recursive: true }).catch(() => []);
		return entries.length === 0;
	  }, 5_000, 100);
	  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 300));
      client = await connect();
      const replay = await client.callTool({ name: "godot_editor", arguments: applyArguments });
      lastStructured = replay.structuredContent;
      expect((replay.structuredContent as { data: unknown }).data).toEqual(appliedData);
      const undo = await client.callTool({
        name: "godot_editor",
        arguments: { operation: "undo", actionId: appliedData.actionId, idempotencyKey: randomUUID() },
      });
      expect(undo.structuredContent).toMatchObject({ ok: true, data: { state: "undone" } });
      const redo = await client.callTool({
        name: "godot_editor",
        arguments: { operation: "redo", actionId: appliedData.actionId, idempotencyKey: randomUUID() },
      });
      expect(redo.structuredContent).toMatchObject({ ok: true, data: { state: "redone" } });
      await client.callTool({
        name: "godot_editor",
        arguments: { operation: "undo", actionId: appliedData.actionId, idempotencyKey: randomUUID() },
      });
      const audit = await readFile(join(project.root, ".godot/evidence/godot-mcp/audit.jsonl"), "utf8");
      expect(audit).toContain('"idempotencyKeySha256"');
      expect(audit).toContain('"rollback":"not_needed"');
      expect(audit).not.toContain(idempotencyKey);
      expect(audit).not.toContain("sensitive-fixture-value");
      await client.close();
      client = undefined;
      await editor.close();
      editor = undefined;
	  const disabled = await runCli(["disable", "--project", project.root]);
	  expect(disabled.exitCode, disabled.stderr).toBe(0);
	  const uninstalled = await runCli(["uninstall", "--project", project.root]);
	  expect(uninstalled.exitCode, uninstalled.stderr).toBe(0);
      expect(await project.diffFromOriginal()).toEqual([]);
      expect(await readdir(join(project.root, "runtime/godot-mcp")).catch(() => [])).toEqual([]);
    } catch (error) {
	  const runtimeEntries = await readdir(join(project.root, "runtime/godot-mcp"), { recursive: true }).catch(() => []);
	  throw new Error(`${String(error)}\nRuntime entries:\n${JSON.stringify(runtimeEntries)}\nLast structured:\n${JSON.stringify(lastStructured)}\nMCP stderr:\n${client?.stderr ?? ""}\nEditor output:\n${editor?.output ?? ""}`);
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
