import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { installAddon, uninstallAddon, upgradeAddon } from "@godot-mcp/cli";
import { copyFixture } from "@godot-mcp/testkit";
import { expect, test } from "vitest";

test("install, upgrade, rollback, and uninstall are independently reversible", async () => {
  const project = await copyFixture();
  const sources = await mkdtemp(join(tmpdir(), "godot-mcp-addon-releases-"));
  const v1 = join(sources, "v1");
  const v2 = join(sources, "v2");
  try {
    await cp(resolve("addons/godot_mcp"), v1, { recursive: true });
    await cp(v1, v2, { recursive: true });
    await writeFile(join(v2, "release-probe.txt"), "phase-11-v2\n");

    await installAddon(project.root, v1);
    expect(await readFile(join(project.root, "addons/godot_mcp/plugin.cfg"), "utf8")).toContain("version=\"0.1.0\"");
    const manifestPath = join(project.root, ".godot/godot-mcp/install-manifest.json");
    const priorManifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(manifestPath, `${JSON.stringify({ ...priorManifest, productVersion: "0.0.9" }, null, 2)}\n`);

    await upgradeAddon(project.root, v2);
    expect(await readFile(join(project.root, "addons/godot_mcp/release-probe.txt"), "utf8")).toBe("phase-11-v2\n");

    await upgradeAddon(project.root, v1);
    await expect(readFile(join(project.root, "addons/godot_mcp/release-probe.txt"), "utf8")).rejects.toThrow();

    await uninstallAddon(project.root);
    expect(await project.diffFromOriginal()).toEqual([]);
  } finally {
    await project.cleanup();
    await rm(sources, { recursive: true, force: true });
  }
});

test("upgrade refuses an independently modified installed file", async () => {
  const project = await copyFixture();
  try {
    await installAddon(project.root, resolve("addons/godot_mcp"));
    const pluginPath = join(project.root, "addons/godot_mcp/plugin.cfg");
    await writeFile(pluginPath, `${await readFile(pluginPath, "utf8")}\n# user change\n`);
    await expect(upgradeAddon(project.root, resolve("addons/godot_mcp"))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(pluginPath, "utf8")).toContain("# user change");
  } finally {
    await project.cleanup();
  }
});
