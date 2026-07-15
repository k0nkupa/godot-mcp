import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { startBridgeServer } from "@godot-mcp/bridge-client";
import { JsonlAuditSink, readProjectIdentity } from "@godot-mcp/control-plane";
import { initProject } from "@godot-mcp/cli";
import { copyFixture, findGodotBinary, runGodot } from "@godot-mcp/testkit";
import { expect, test } from "vitest";

test("Godot addon matches crypto fixtures and attaches to the loopback bridge", async () => {
  const project = await copyFixture();
  const originalRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
  let editor: ReturnType<typeof spawn> | undefined;
  try {
    process.env.XDG_RUNTIME_DIR = join(project.root, "runtime");
    await mkdir(join(project.root, "protocol-fixtures"));
    await copyFile(
      resolve(process.cwd(), "packages/protocol/fixtures/session-crypto-v1.json"),
      join(project.root, "protocol-fixtures/session-crypto-v1.json"),
    );
    await initProject(
      project.root,
      resolve(process.cwd(), "addons/godot_mcp"),
      process.env.GODOT_BIN,
    );

    const cryptoResult = await runGodot([
      "--headless",
      "--path",
      project.root,
      "--script",
      "res://tests/protocol_fixture_test.gd",
    ], { timeoutMs: 5_000 });
    expect(cryptoResult.exitCode, cryptoResult.stderr).toBe(0);
    expect(`${cryptoResult.stdout}\n${cryptoResult.stderr}`).toContain(
      "GODOT_MCP_PROTOCOL_FIXTURE_OK",
    );

    const identity = await readProjectIdentity(project.root);
    const manifest = JSON.parse(
      await readFile(join(project.root, ".godot/godot-mcp/install-manifest.json"), "utf8"),
    ) as { manifestSha256: string };
    const server = await startBridgeServer({
      project: identity,
      grants: { tiers: ["observe"], packs: ["core"] },
      addonManifestSha256: manifest.manifestSha256,
      auditSink: new JsonlAuditSink(join(project.root, "pairing-audit.jsonl")),
    });
    try {
      const godot = await findGodotBinary();
      editor = spawn(godot, ["--headless", "--editor", "--path", project.root], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let editorOutput = "";
      editor.stdout?.on("data", (chunk: Buffer) => {
        editorOutput += chunk.toString();
      });
      editor.stderr?.on("data", (chunk: Buffer) => {
        editorOutput += chunk.toString();
      });

      let session;
      try {
        session = await Promise.race([
          server.waitForAttachment(10_000),
          new Promise<never>((_resolve, reject) => {
            editor?.once("exit", (code) =>
              reject(new Error(`Godot editor exited early (${code})\n${editorOutput}`)),
            );
          }),
        ]);
      } catch (error) {
        throw new Error(`${(error as Error).message}\n${editorOutput}`);
      }
      expect(session.info.project).toEqual(identity);
      expect(session.info.godotVersion).toMatch(/^4\.7\.stable/);
      await server.close();
      await expect(readFile(server.descriptorPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (editor && editor.exitCode === null) {
        editor.kill("SIGTERM");
        const closed = await Promise.race([
          new Promise<boolean>((resolvePromise) => editor?.once("close", () => resolvePromise(true))),
          new Promise<boolean>((resolvePromise) => setTimeout(() => resolvePromise(false), 2_000)),
        ]);
        if (!closed && editor.exitCode === null) {
          editor.kill("SIGKILL");
          await Promise.race([
            new Promise<void>((resolvePromise) => editor?.once("close", () => resolvePromise())),
            new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1_000)),
          ]);
        }
      }
      await server.close();
    }
  } finally {
    if (originalRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = originalRuntimeDirectory;
    await project.cleanup();
  }
}, 30_000);
