import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { disableAddon, initProject, runDoctor, uninstallAddon } from "@godot-mcp/cli";
import { copyFixture } from "@godot-mcp/testkit";
import { expect, test } from "vitest";

test("init, disable, and uninstall are reversible with real Godot", async () => {
  const project = await copyFixture();
  try {
    await initProject(
      project.root,
      resolve(process.cwd(), "addons/godot_mcp"),
      process.env.GODOT_BIN,
    );
    expect(await readFile(join(project.root, "project.godot"), "utf8")).toContain(
      "res://addons/godot_mcp/plugin.cfg",
    );
    expect((await runDoctor(project.root)).healthy).toBe(true);

    await disableAddon(project.root, process.env.GODOT_BIN);
    expect(await readFile(join(project.root, "project.godot"), "utf8")).not.toContain(
      "res://addons/godot_mcp/plugin.cfg",
    );

    await uninstallAddon(project.root);
    expect(await project.diffFromOriginal()).toEqual([]);
  } finally {
    await project.cleanup();
  }
});
