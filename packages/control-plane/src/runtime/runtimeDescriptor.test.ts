import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { copyFixture } from "@godot-mcp/testkit";
import { afterEach, expect, it } from "vitest";

import { consumeRuntimeDescriptor, createRuntimeDescriptor } from "./runtimeDescriptor.js";

const cleanups: Array<() => Promise<void>> = [];
const originalRuntimeDirectory = process.env.XDG_RUNTIME_DIR;

afterEach(async () => {
  if (originalRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = originalRuntimeDirectory;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("creates an owner-only one-use runtime descriptor", async () => {
  const project = await copyFixture();
  cleanups.push(project.cleanup);
  process.env.XDG_RUNTIME_DIR = join(project.root, "runtime");
  const input = {
    project: {
      projectId: "019f644c-1379-79c0-825e-66a4b7653bd1",
      rootRealPath: project.root,
      projectConfigSha256: "a".repeat(64),
    },
    sessionId: "session_12345678",
    runId: "019f644c-1379-79c0-825e-66a4b7653bd2",
    generation: 1,
    scenePath: "res://runtime/runtime_fixture.tscn",
  };

  const material = await createRuntimeDescriptor(input);
  cleanups.push(material.cleanup);

  expect((await lstat(material.path)).mode & 0o777).toBe(0o600);
  expect(material.descriptor.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await expect(consumeRuntimeDescriptor(material.path, input)).resolves.toMatchObject(input);
  await expect(consumeRuntimeDescriptor(material.path, input)).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
});

it("rejects expired and mismatched descriptors", async () => {
  const project = await copyFixture();
  cleanups.push(project.cleanup);
  process.env.XDG_RUNTIME_DIR = join(project.root, "runtime");
  const input = {
    project: {
      projectId: "019f644c-1379-79c0-825e-66a4b7653bd1",
      rootRealPath: project.root,
      projectConfigSha256: "b".repeat(64),
    },
    sessionId: "session_12345678",
    runId: "019f644c-1379-79c0-825e-66a4b7653bd3",
    generation: 2,
    scenePath: "res://runtime/runtime_fixture.tscn",
    now: 1,
  };
  const expired = await createRuntimeDescriptor(input);
  cleanups.push(expired.cleanup);
  await expect(consumeRuntimeDescriptor(expired.path, { ...input, now: 61_002 })).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });

  const mismatch = await createRuntimeDescriptor({ ...input, runId: "019f644c-1379-79c0-825e-66a4b7653bd4" });
  cleanups.push(mismatch.cleanup);
  await expect(consumeRuntimeDescriptor(mismatch.path, input)).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
});
