import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import { copyFixture } from "@godot-mcp/testkit";
import { afterEach, describe, expect, it } from "vitest";

import { createProjectConfig, discoverProject, readProjectIdentity } from "../index.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
});

describe("project identity", () => {
  it("fingerprints project.godot and uses the configured UUID", async () => {
    const temp = await copyFixture();
    cleanups.push(temp.cleanup);

    const config = await createProjectConfig(temp.root);
    const identity = await readProjectIdentity(temp.root);

    expect(identity.projectId).toBe(config.projectId);
    expect(identity.rootRealPath).toBe(await realpath(temp.root));
    expect(identity.projectConfigSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns an existing valid config unchanged", async () => {
    const temp = await copyFixture();
    cleanups.push(temp.cleanup);

    const first = await createProjectConfig(temp.root);
    const before = await readFile(join(temp.root, ".godot-mcp.json"), "utf8");
    const second = await createProjectConfig(temp.root);

    expect(second).toEqual(first);
    expect(await readFile(join(temp.root, ".godot-mcp.json"), "utf8")).toBe(before);
  });

  it("discovers only the supplied directory or project.godot path", async () => {
    const temp = await copyFixture();
    cleanups.push(temp.cleanup);

    const canonicalRoot = await realpath(temp.root);
    expect((await discoverProject(temp.root)).rootRealPath).toBe(canonicalRoot);
    expect((await discoverProject(join(temp.root, "project.godot"))).rootRealPath).toBe(canonicalRoot);
    await expect(discoverProject(join(temp.root, "tests"))).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });
});
