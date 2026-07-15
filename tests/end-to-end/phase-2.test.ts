import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  copyFixture,
  inspectPng,
  launchEditor,
  launchMcpClient,
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
    join(directory, "phase-2-end-to-end-audit.jsonl"),
  ).catch(() => undefined);
  await writeFile(join(directory, "phase-2-end-to-end-editor.log"), editorOutput, "utf8");
  await writeFile(join(directory, "phase-2-end-to-end-mcp-stderr.log"), mcpStderr, "utf8");
  await writeFile(
    join(directory, "phase-2-end-to-end-receipt.json"),
    `${JSON.stringify(lastStructured ?? null)}\n`,
    "utf8",
  );
}

test.skipIf(process.platform !== "darwin")(
  "Phase 2 works through published stdio and a visible Godot editor",
  async () => {
    const project = await copyFixture();
    const scene = "res://observation/editor_2d.tscn";
    const originalRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = join(project.root, "runtime");
    let editor: Awaited<ReturnType<typeof launchEditor>> | undefined;
    let client: Awaited<ReturnType<typeof launchMcpClient>> | undefined;
    let lastStructured: unknown;
    try {
      const imported = await runGodot(["--headless", "--editor", "--path", project.root, "--import"]);
      expect(imported.exitCode, imported.stderr).toBe(0);
      const initialized = await runCli(["init", "--project", project.root]);
      expect(initialized.exitCode, initialized.stderr).toBe(0);

      editor = await launchEditor(project.root, { scene, headless: false });
      client = await launchMcpClient(["connect", "--project", project.root]);
      await waitUntil(
        async () => {
          const result = await client?.callTool({ name: "godot_session", arguments: {} });
          const structured = result?.structuredContent as { data?: { state?: string } } | undefined;
          return structured?.data?.state === "attached";
        },
        15_000,
        100,
      );

      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        "godot_capabilities",
        "godot_capture",
        "godot_doctor",
        "godot_help",
        "godot_query",
        "godot_session",
      ]);

      let state: Awaited<ReturnType<typeof client.callTool>> | undefined;
      await waitUntil(
        async () => {
          state = await client?.callTool({
            name: "godot_query",
            arguments: { operation: "editor_state" },
          });
          return (state?.structuredContent as { data?: { editedScene?: string } } | undefined)?.data
            ?.editedScene === scene;
        },
        10_000,
        100,
      );
      lastStructured = state.structuredContent;
      expect(state.structuredContent).toMatchObject({
        ok: true,
        data: { editedScene: scene, unsavedScenes: [] },
      });

      const node = await client.callTool({
        name: "godot_query",
        arguments: { operation: "node", scenePath: scene, nodePath: "ObservedNode" },
      });
      lastStructured = node.structuredContent;
      expect(node.structuredContent).toMatchObject({
        ok: true,
        data: {
          groups: expect.arrayContaining(["observable", "ui"]),
          script: { path: "res://observation/fixture_script.gd" },
        },
      });
      expect(JSON.stringify(node.structuredContent)).toContain("phase-2-2d");

      const capture = await client.callTool({
        name: "godot_capture",
        arguments: { viewport: "2d", maxWidth: 800, maxHeight: 600 },
      });
      lastStructured = capture.structuredContent;
      const image = capture.content.find(
        (block): block is { type: "image"; data: string; mimeType: string } =>
          typeof block === "object" && block !== null && (block as { type?: string }).type === "image",
      );
      expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
      const png = Buffer.from(image?.data ?? "", "base64");
      const inspected = inspectPng(png);
      expect(inspected.width).toBeGreaterThan(64);
      expect(inspected.height).toBeGreaterThan(64);
      expect(inspected.width).toBeLessThanOrEqual(800);
      expect(inspected.height).toBeLessThanOrEqual(600);
      expect(inspected.uniqueColors).toBeGreaterThan(1);
      const captureData = (capture.structuredContent as {
        data: { sha256: string; evidenceUri: string; byteLength: number };
      }).data;
      expect(captureData.evidenceUri).toMatch(/^godot-mcp:\/\/evidence\/[a-f0-9]{64}$/);
      expect(createHash("sha256").update(png).digest("hex")).toBe(captureData.sha256);
      expect(png.byteLength).toBe(captureData.byteLength);

      const evidenceDirectory = join(
        project.root,
        ".godot/evidence/godot-mcp/sessions",
      );
      const sessions = await readdir(evidenceDirectory);
      expect(sessions).toHaveLength(1);
      expect(
        await readFile(join(evidenceDirectory, sessions[0]!, `${captureData.sha256}.png`)),
      ).toEqual(png);
      const audit = await readFile(
        join(project.root, ".godot/evidence/godot-mcp/audit.jsonl"),
        "utf8",
      );
      expect(audit).toContain("godot_query");
      expect(audit).toContain("godot_capture");
      expect(audit).not.toContain(image?.data ?? "unreachable-image-data");

      await client.close();
      client = undefined;
      await editor.close();
      editor = undefined;
      expect((await runCli(["disable", "--project", project.root])).exitCode).toBe(0);
      const uninstalled = await runCli(["uninstall", "--project", project.root]);
      expect(
        uninstalled.exitCode,
        `${uninstalled.stderr}\nChanged paths:\n${(await project.diffFromOriginal()).join("\n")}`,
      ).toBe(0);
      expect(await project.diffFromOriginal()).toEqual([]);
      expect(await readdir(join(project.root, "runtime/godot-mcp")).catch(() => [])).toEqual([]);
    } catch (error) {
      await preserveFailureReceipts(
        project.root,
        editor?.output ?? "",
        client?.stderr ?? "",
        lastStructured,
      );
      throw new Error(
        `${String(error)}\nLast structured:\n${JSON.stringify(lastStructured)}\nMCP stderr:\n${client?.stderr ?? ""}\nEditor output:\n${editor?.output ?? ""}`,
      );
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
