import { appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { copyFixture } from "@godot-mcp/testkit";
import { afterEach, expect, it } from "vitest";

import { installAddon, runDoctor } from "../index.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
});

it("reports installed file hash drift without mutating it", async () => {
  const project = await copyFixture();
  cleanups.push(project.cleanup);
  await installAddon(project.root, resolve(process.cwd(), "addons/godot_mcp"));
  const installed = join(project.root, "addons/godot_mcp/plugin.gd");
  await appendFile(installed, "\n# drift\n");

  const report = await runDoctor(project.root);

  expect(report.healthy).toBe(false);
  expect(report.checks).toContainEqual(
    expect.objectContaining({ name: "addon-files", status: "error" }),
  );
});
