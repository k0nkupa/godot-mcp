import { access } from "node:fs/promises";
import { join, resolve } from "node:path";

import { copyFixture } from "@godot-mcp/testkit";
import { afterEach, expect, it } from "vitest";

import { createRuntime, installAddon } from "../index.js";

const cleanups: Array<() => Promise<void>> = [];
const originalRuntimeDirectory = process.env.XDG_RUNTIME_DIR;

afterEach(async () => {
  if (originalRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = originalRuntimeDirectory;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

it("creates an observe-only runtime and removes its descriptor on concurrent close", async () => {
  const project = await copyFixture();
  cleanups.push(project.cleanup);
  process.env.XDG_RUNTIME_DIR = join(project.root, "runtime");
  await installAddon(project.root, resolve(process.cwd(), "addons/godot_mcp"));

  const runtime = await createRuntime({ project: project.root });
  cleanups.push(() => runtime.close("cleanup"));

  expect(runtime.session.snapshot().grants).toEqual({ tiers: ["observe"], packs: ["core"] });
  expect(await pathExists(runtime.bridge.descriptorPath)).toBe(true);
  await Promise.all([runtime.close("test"), runtime.close("test-again")]);
  expect(await pathExists(runtime.bridge.descriptorPath)).toBe(false);
});

it("uses only explicitly supplied runtime grants", async () => {
  const project = await copyFixture();
  cleanups.push(project.cleanup);
  process.env.XDG_RUNTIME_DIR = join(project.root, "runtime");
  await installAddon(project.root, resolve(process.cwd(), "addons/godot_mcp"));

  const runtime = await createRuntime({
    project: project.root,
    grants: { tiers: ["observe", "runtime_control"], packs: ["core", "runtime"] },
  });
  cleanups.push(() => runtime.close("cleanup"));

  expect(runtime.session.snapshot().grants).toEqual({
    tiers: ["observe", "runtime_control"],
    packs: ["core", "runtime"],
  });
});
