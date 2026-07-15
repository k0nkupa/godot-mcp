import {
  copyFixture,
  launchEditor,
  launchMcpClient,
  runCli,
  waitUntil,
} from "@godot-mcp/testkit";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";

async function preserveFailureArtifacts(
  projectRoot: string,
  editorOutput: string,
  mcpStderr: string,
): Promise<void> {
  const directory = process.env.GODOT_MCP_FAILURE_ARTIFACT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await copyFile(
    join(projectRoot, ".godot/evidence/godot-mcp/audit.jsonl"),
    join(directory, "end-to-end-audit.jsonl"),
  ).catch(() => undefined);
  await writeFile(join(directory, "end-to-end-editor.log"), editorOutput, "utf8");
  await writeFile(join(directory, "end-to-end-mcp-stderr.log"), mcpStderr, "utf8");
}

test("Phase 0-1 works through CLI, real editor, and MCP stdio", async () => {
  const project = await copyFixture();
  const originalRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = `${project.root}/runtime`;
  let editor: Awaited<ReturnType<typeof launchEditor>> | undefined;
  let client: Awaited<ReturnType<typeof launchMcpClient>> | undefined;
  try {
    const initialized = await runCli(["init", "--project", project.root]);
    expect(initialized.exitCode, initialized.stderr).toBe(0);

    editor = await launchEditor(project.root);
    client = await launchMcpClient(["connect", "--project", project.root]);
    try {
      await waitUntil(
        async () => {
          const result = await client?.callTool({ name: "godot_session", arguments: {} });
          const structured = result?.structuredContent as
            | { data?: { state?: string } }
            | undefined;
          return structured?.data?.state === "attached";
        },
        10_000,
        100,
      );
    } catch (error) {
      const runtimeEntries = await readdir(join(project.root, "runtime/godot-mcp")).catch(() => []);
      const audit = await readFile(
        join(project.root, ".godot/evidence/godot-mcp/audit.jsonl"),
        "utf8",
      ).catch(() => "");
      throw new Error(
        `${(error as Error).message}\nRuntime entries: ${runtimeEntries.join(",")}\nAudit:\n${audit}\nMCP stderr:\n${client.stderr}\nEditor output:\n${editor.output}`,
      );
    }

    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "godot_capabilities",
      "godot_doctor",
      "godot_help",
      "godot_session",
    ]);
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
  } catch (error) {
    await preserveFailureArtifacts(project.root, editor?.output ?? "", client?.stderr ?? "");
    throw error;
  } finally {
    await client?.close();
    await editor?.close();
    if (originalRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = originalRuntimeDirectory;
    await project.cleanup();
  }
}, 30_000);
