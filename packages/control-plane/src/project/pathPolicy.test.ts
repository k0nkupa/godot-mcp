import { mkdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";

import { copyFixture } from "@godot-mcp/testkit";
import { afterEach, describe, expect, it } from "vitest";

import { readProjectIdentity, resolveProjectPath } from "../index.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
});

describe("project path policy", () => {
  it("resolves resources inside the canonical project root", async () => {
    const temp = await copyFixture();
    cleanups.push(temp.cleanup);
    await mkdir(join(temp.root, "generated"));
    const identity = await readProjectIdentity(temp.root);

    const canonicalRoot = await realpath(temp.root);
    await expect(resolveProjectPath(identity, "res://main.gd", "read")).resolves.toBe(
      join(canonicalRoot, "main.gd"),
    );
    await expect(resolveProjectPath(identity, "res://generated/new.gd", "write")).resolves.toBe(
      join(canonicalRoot, "generated/new.gd"),
    );
  });

  it("rejects a symlink that escapes res://", async () => {
    const temp = await copyFixture();
    cleanups.push(temp.cleanup);
    await symlink("/tmp", join(temp.root, "escape"));
    const identity = await readProjectIdentity(temp.root);

    await expect(resolveProjectPath(identity, "res://escape/secret", "read")).rejects.toMatchObject({
      code: "PATH_DENIED",
    });
    await expect(
      resolveProjectPath(identity, "res://escape/missing/new.gd", "write"),
    ).rejects.toMatchObject({ code: "PATH_DENIED" });
  });

  it.each(["../outside", "user://save", "res://.git/config", "res://.env", "res://api-key.txt"])(
    "rejects denied resource path %s",
    async (resourcePath) => {
      const temp = await copyFixture();
      cleanups.push(temp.cleanup);
      const identity = await readProjectIdentity(temp.root);

      await expect(resolveProjectPath(identity, resourcePath, "write")).rejects.toMatchObject({
        code: "PATH_DENIED",
      });
    },
  );
});
