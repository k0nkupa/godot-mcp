import { access } from "node:fs/promises";
import { join, resolve } from "node:path";

import { copyFixture } from "@godot-mcp/testkit";
import { afterEach, expect, it } from "vitest";

import { createRuntime, GodotMcpRuntime, installAddon } from "../index.js";

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

it("accepts an independently selected input pack with runtime_control", async () => {
  const project = await copyFixture();
  cleanups.push(project.cleanup);
  process.env.XDG_RUNTIME_DIR = join(project.root, "runtime");
  await installAddon(project.root, resolve(process.cwd(), "addons/godot_mcp"));

  const runtime = await createRuntime({
    project: project.root,
    grants: { tiers: ["observe", "runtime_control"], packs: ["core", "input"] },
  });
  cleanups.push(() => runtime.close("cleanup"));
  expect(runtime.session.snapshot().grants).toEqual({
    tiers: ["observe", "runtime_control"],
    packs: ["core", "input"],
  });
});

it("accepts an independently selected editor pack with project_mutate", async () => {
  const project = await copyFixture();
  cleanups.push(project.cleanup);
  process.env.XDG_RUNTIME_DIR = join(project.root, "runtime");
  await installAddon(project.root, resolve(process.cwd(), "addons/godot_mcp"));

  const runtime = await createRuntime({
    project: project.root,
    grants: { tiers: ["observe", "project_mutate"], packs: ["core", "editor"] },
  });
  cleanups.push(() => runtime.close("cleanup"));
  expect(runtime.session.snapshot().grants).toEqual({
    tiers: ["observe", "project_mutate"],
    packs: ["core", "editor"],
  });
});

it("rejects inconsistent programmatic runtime grants", async () => {
  const project = await copyFixture();
  cleanups.push(project.cleanup);
  process.env.XDG_RUNTIME_DIR = join(project.root, "runtime");

  await expect(createRuntime({
    project: project.root,
    grants: { tiers: ["observe", "runtime_control"], packs: ["core"] },
  })).rejects.toThrow("runtime_control must be granted with runtime or input packs");
  await expect(createRuntime({
    project: project.root,
    grants: { tiers: ["observe", "project_mutate"], packs: ["core"] },
  })).rejects.toThrow("editor pack");
});

it("closes every outer resource while preserving runtime cleanup failures", async () => {
  const closed: string[] = [];
  let runtimeCloseCalls = 0;
  const runtime = new GodotMcpRuntime(
    {} as never,
    {} as never,
    { close: () => { closed.push("session"); } } as never,
    { close: async () => { closed.push("bridge"); } } as never,
    { close: async () => {
      runtimeCloseCalls += 1;
      if (runtimeCloseCalls === 1) throw new Error("owned child remains");
    } } as never,
    { close: async () => { closed.push("mcp"); } } as never,
  );

  await expect(runtime.close("test")).rejects.toThrow("owned child remains");
  expect(closed).toEqual(expect.arrayContaining(["mcp", "bridge", "session"]));
  await expect(runtime.close("retry")).resolves.toBeUndefined();
  expect(runtimeCloseCalls).toBe(2);
});
