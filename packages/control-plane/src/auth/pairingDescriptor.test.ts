import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { copyFixture } from "@godot-mcp/testkit";
import { afterEach, describe, expect, it } from "vitest";

import {
  consumePairingDescriptor,
  createPairingDescriptor,
  readProjectIdentity,
  type SessionGrants,
} from "../index.js";

const cleanups: Array<() => Promise<void>> = [];
const originalRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
const observeGrants: SessionGrants = { tiers: ["observe"], packs: ["core"] };

afterEach(async () => {
  if (originalRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = originalRuntimeDirectory;
  await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
});

describe("pairing descriptors", () => {
  it("creates a 0600 descriptor with a 32-byte one-use token", async () => {
    const project = await copyFixture();
    cleanups.push(project.cleanup);
    process.env.XDG_RUNTIME_DIR = join(project.root, "runtime");
    const identity = await readProjectIdentity(project.root);

    const material = await createPairingDescriptor(identity, 43_123, observeGrants);

    expect(Buffer.from(material.descriptor.token, "base64url")).toHaveLength(32);
    expect(Buffer.from(material.descriptor.sessionNonce, "base64url")).toHaveLength(32);
    expect((await stat(material.path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(project.root, "runtime/godot-mcp"))).mode & 0o777).toBe(0o700);
    await expect(consumePairingDescriptor(material.path)).resolves.toEqual(material.descriptor);
    await expect(consumePairingDescriptor(material.path)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
  });

  it("rejects and deletes an expired descriptor", async () => {
    const project = await copyFixture();
    cleanups.push(project.cleanup);
    process.env.XDG_RUNTIME_DIR = join(project.root, "runtime");
    const identity = await readProjectIdentity(project.root);
    const material = await createPairingDescriptor(identity, 43_123, observeGrants);
    const expired = { ...material.descriptor, expiresAtUnixMs: Date.now() - 1 };
    await writeFile(material.path, `${JSON.stringify(expired)}\n`, { mode: 0o600 });

    await expect(consumePairingDescriptor(material.path)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
    await expect(readFile(material.path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
