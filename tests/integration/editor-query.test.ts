import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { startBridgeServer } from "@godot-mcp/bridge-client";
import { JsonlAuditSink, readProjectIdentity } from "@godot-mcp/control-plane";
import { initProject } from "@godot-mcp/cli";
import { copyFixture, findGodotBinary, waitUntil } from "@godot-mcp/testkit";
import { expect, test } from "vitest";

test("attached addon returns bounded editor state and the open scene tree", async () => {
  const project = await copyFixture();
  const originalRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = join(project.root, "runtime");
  let editor: ReturnType<typeof spawn> | undefined;
  let editorOutput = "";
  try {
    await initProject(project.root, resolve(process.cwd(), "addons/godot_mcp"), process.env.GODOT_BIN);
    const identity = await readProjectIdentity(project.root);
    const manifest = JSON.parse(
      await readFile(join(project.root, ".godot/godot-mcp/install-manifest.json"), "utf8"),
    ) as { manifestSha256: string };
    const server = await startBridgeServer({
      project: identity,
      grants: { tiers: ["observe"], packs: ["core"] },
      addonManifestSha256: manifest.manifestSha256,
      auditSink: new JsonlAuditSink(join(project.root, "query-audit.jsonl")),
    });
    try {
      editor = spawn(
        await findGodotBinary(),
        ["--headless", "--editor", "--path", project.root, "res://main.tscn"],
        { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
      );
      editor.stdout?.on("data", (chunk: Buffer) => { editorOutput += chunk.toString(); });
      editor.stderr?.on("data", (chunk: Buffer) => { editorOutput += chunk.toString(); });
      const session = await server.waitForAttachment(10_000).catch((error: unknown) => {
        throw new Error(`${String(error)}\n${editorOutput}`);
      });
      let state: Awaited<ReturnType<typeof session.request<Record<string, unknown>>>> | undefined;
      await waitUntil(async () => {
        state = await session.request<Record<string, unknown>>(
          "editor.query",
          { operation: "editor_state" },
          { timeoutMs: 5_000 },
        );
        return state.data.editedScene === "res://main.tscn";
      }, 10_000, 100);
      expect(state?.data).toMatchObject({ operation: "editor_state", editedScene: "res://main.tscn" });
      const tree = await session.request<{ nodes: Array<{ nodePath: string }> }>(
        "editor.query",
        { operation: "scene_tree", maxDepth: 4, maxNodes: 20 },
        { timeoutMs: 5_000 },
      );
      expect(tree.data.nodes.map((node) => node.nodePath)).toEqual([".", "StatusLabel"]);
    } finally {
      await server.close();
    }
  } catch (error) {
    throw new Error(`${String(error)}\n${editorOutput}`);
  } finally {
    if (editor?.exitCode === null) editor.kill("SIGTERM");
    if (originalRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = originalRuntimeDirectory;
    await project.cleanup();
  }
}, 30_000);
