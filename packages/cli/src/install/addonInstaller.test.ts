import { appendFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { copyFixture } from "@godot-mcp/testkit";
import { afterEach, describe, expect, it } from "vitest";

import { installAddon, uninstallAddon } from "../index.js";
import { hashFileEntries, parseInstallManifest } from "./addonManifest.js";

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

  it("accepts prior-version ownership but rejects unsafe manifest paths", async () => {
    const project = await copyFixture(); cleanups.push(project.cleanup);
    const installed = await installAddon(project.root, addonSource);
    expect(parseInstallManifest({ ...installed.manifest, productVersion: "0.0.9" })).toMatchObject({ productVersion: "0.0.9" });
    const files = installed.manifest.files.map((file, index) => index === 0 ? { ...file, relativePath: "addons/godot_mcp/../../outside" } : file);
    expect(() => parseInstallManifest({ ...installed.manifest, files, manifestSha256: hashFileEntries(files) })).toThrow(/invalid shape/i);
    expect(() => parseInstallManifest({ ...installed.manifest, productVersion: "999.0.0" })).toThrow(/invalid shape/i);
  });
});
