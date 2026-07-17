import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { copyFixture, launchEditor, launchMcpClient, runCli, runGodot, waitUntil } from "@godot-mcp/testkit";
import { expect, test } from "vitest";

const scene = "res://authoring/authoring_scene.tscn";

test.skipIf(process.platform !== "darwin")(
  "Phase 6 authors resources and source through published stdio with explicit authorization",
  async () => {
    const project = await copyFixture();
    const previousRuntime = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = join(project.root, "runtime");
    let editor: Awaited<ReturnType<typeof launchEditor>> | undefined;
    let client: Awaited<ReturnType<typeof launchMcpClient>> | undefined;
    let lastStructured: unknown;
    try {
      const imported = await runGodot(["--headless", "--editor", "--path", project.root, "--import"]);
      expect(imported.exitCode, imported.stderr).toBe(0);
      expect((await runCli(["init", "--project", project.root])).exitCode).toBe(0);
      editor = await launchEditor(project.root, { headless: true, scene });

      const connect = async (authorized: boolean) => {
        const next = await launchMcpClient([
          "connect", "--project", project.root,
          ...(authorized ? ["--grant", "project_mutate", "--pack", "editor"] : []),
        ]);
        await waitUntil(async () => {
          const status = await next.callTool({ name: "godot_session", arguments: {} });
          return (status.structuredContent as { data?: { state?: string } } | undefined)?.data?.state === "attached";
        }, 15_000, 100);
        return next;
      };

      client = await connect(false);
      expect((await client.listTools()).tools.map(({ name }) => name).sort()).toEqual([
        "godot_capabilities", "godot_capture", "godot_doctor", "godot_help", "godot_query", "godot_session",
      ]);
      await client.close();
      client = undefined;
      await waitUntil(async () => (await readdir(join(project.root, "runtime/godot-mcp"), { recursive: true }).catch(() => [])).length === 0, 5_000, 100);

      client = await connect(true);
      expect((await client.listTools()).tools.map(({ name }) => name).sort()).toEqual([
        "godot_capabilities", "godot_capture", "godot_doctor", "godot_editor", "godot_help", "godot_query", "godot_session",
      ]);
      await waitUntil(async () => {
        const state = await client?.callTool({ name: "godot_query", arguments: { operation: "editor_state" } });
        return (state?.structuredContent as { data?: { editedScene?: string } } | undefined)?.data?.editedScene === scene;
      }, 10_000, 100);
      const resourceSteps = [
        { operation: "set_resource_property", target: { resourcePath: "res://authoring/authoring_material.tres", propertyPath: [] }, property: "roughness", value: 0.375 },
        { operation: "upsert_animation", target: { resourcePath: "res://authoring/authoring_animation_library.tres", propertyPath: [] }, animationName: "stdio_walk", length: 1.5, loopMode: "linear" },
      ];
      const resourceAction = await apply(client, resourceSteps);
      expect(await readFile(join(project.root, "authoring/authoring_material.tres"), "utf8")).toContain("roughness = 0.375");
      expect(await readFile(join(project.root, "authoring/authoring_animation_library.tres"), "utf8")).toContain("stdio_walk");

      const sourceText = "extends Node\nvar stdio_phase := 6\n";
      const sourceSteps = [{ operation: "create_script", sourcePath: "res://authoring/stdio_phase6.gd", content: sourceText }];
      const sourceAction = await apply(client, sourceSteps);
      expect(await readFile(join(project.root, "authoring/stdio_phase6.gd"), "utf8")).toBe(sourceText);

      const resources = await client.callTool({ name: "godot_query", arguments: { operation: "resources", kinds: ["resource", "script"], limit: 100 } });
      lastStructured = resources.structuredContent;
      expect(JSON.stringify(resources.structuredContent)).toContain("authoring_material.tres");

      await change(client, "undo", sourceAction);
      await change(client, "undo", resourceAction);
      await change(client, "redo", resourceAction);
      await change(client, "undo", resourceAction);

      const audit = await readFile(join(project.root, ".godot/evidence/godot-mcp/audit.jsonl"), "utf8");
      expect(audit).toContain('"sourceContentSha256"');
      expect(audit).not.toContain(sourceText.trim());
      await client.close(); client = undefined;
      await editor.close(); editor = undefined;
      const disabled = await runCli(["disable", "--project", project.root]);
      expect(disabled.exitCode, `${disabled.stdout}\n${disabled.stderr}`).toBe(0);
      const uninstalled = await runCli(["uninstall", "--project", project.root]);
      expect(uninstalled.exitCode, `${uninstalled.stdout}\n${uninstalled.stderr}`).toBe(0);
      const finalDiff = await project.diffFromOriginal();
      if (finalDiff.length > 0) throw new Error(`Project cleanup diff: ${JSON.stringify(finalDiff)}`);
      expect(await readdir(join(project.root, "runtime/godot-mcp")).catch(() => [])).toEqual([]);
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

async function apply(client: NonNullable<Awaited<ReturnType<typeof launchMcpClient>>>, steps: Array<Record<string, unknown>>): Promise<string> {
  const preview = await client.callTool({ name: "godot_editor", arguments: { operation: "preview", steps } });
  expect(preview.structuredContent, JSON.stringify(preview.structuredContent)).toMatchObject({ ok: true, data: { state: "previewed", planDigest: expect.any(String) } });
  const digest = (preview.structuredContent as { data: { planDigest: string } }).data.planDigest;
  const result = await client.callTool({ name: "godot_editor", arguments: { operation: "apply", idempotencyKey: randomUUID(), expectedPlanDigest: digest, steps } });
  expect(result.structuredContent, JSON.stringify(result.structuredContent)).toMatchObject({ ok: true, data: { state: "applied", actionId: expect.any(String) } });
  return (result.structuredContent as { data: { actionId: string } }).data.actionId;
}

async function change(client: NonNullable<Awaited<ReturnType<typeof launchMcpClient>>>, operation: "undo" | "redo", actionId: string): Promise<void> {
  const result = await client.callTool({ name: "godot_editor", arguments: { operation, actionId, idempotencyKey: randomUUID() } });
  expect(result.structuredContent, JSON.stringify(result.structuredContent)).toMatchObject({ ok: true, data: { state: operation === "undo" ? "undone" : "redone" } });
}
