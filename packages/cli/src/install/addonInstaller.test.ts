import { appendFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { copyFixture } from "@godot-mcp/testkit";
import { afterEach, describe, expect, it } from "vitest";

import { installAddon, uninstallAddon } from "../index.js";

const cleanups: Array<() => Promise<void>> = [];
const addonSource = resolve(process.cwd(), "addons/godot_mcp");

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
});

describe("addon installer", () => {
  it("installs exact addon files and refuses to overwrite a user modification", async () => {
    const project = await copyFixture();
    cleanups.push(project.cleanup);
    await installAddon(project.root, addonSource);
    const installed = join(project.root, "addons/godot_mcp/plugin.gd");

    await appendFile(installed, "\n# user change\n");

    await expect(uninstallAddon(project.root)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(installed, "utf8")).toContain("# user change");
  });

  it("removes a pristine install and its generated project config", async () => {
    const project = await copyFixture();
    cleanups.push(project.cleanup);
    await installAddon(project.root, addonSource);

    await uninstallAddon(project.root);

    await expect(readFile(join(project.root, ".godot-mcp.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await project.diffFromOriginal()).toEqual([]);
  });
});
