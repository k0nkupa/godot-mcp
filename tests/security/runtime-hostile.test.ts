import { access, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  consumeRuntimeDescriptor,
  createRuntimeDescriptor,
  readProjectIdentity,
} from "@godot-mcp/control-plane";
import {
  RuntimeCaptureInputSchema,
  RuntimeCommandSchema,
  RuntimeOperationInputSchema,
} from "@godot-mcp/protocol";
import { copyFixture } from "@godot-mcp/testkit";
import { describe, expect, it } from "vitest";

const handle = { runId: "019f644c-1379-79c0-825e-66a4b7653bd1", generation: 1 };

describe("hostile runtime boundaries", () => {
  it.each([
    { operation: "launch", scenePath: "res://../escape.tscn" },
    { operation: "launch", scenePath: "/tmp/escape.tscn" },
    { operation: "tree", handle, root: "../Escape" },
    { operation: "tree", handle, root: ".", maxDepth: 33 },
    { operation: "tree", handle, root: ".", maxNodes: 1001 },
    { operation: "node", handle, nodePath: "Child:secret" },
    { operation: "node", handle, nodePath: "/root/Outside" },
    { operation: "logs", handle, limit: 501 },
    { operation: "step", handle, frames: 121 },
    { operation: "wait", handle, timeoutMs: 30_001, condition: { type: "frames_elapsed", frames: 1 } },
  ])("rejects hostile runtime input %# before dispatch", (input) => {
    expect(() => RuntimeOperationInputSchema.parse(input)).toThrow();
  });

  it.each([
    { handle, maxWidth: 2049 },
    { handle, maxHeight: 0 },
    { handle, frameCount: 9 },
    { handle, intervalFrames: 121 },
    { handle, unexpected: true },
  ])("rejects hostile capture input %# before dispatch", (input) => {
    expect(() => RuntimeCaptureInputSchema.parse(input)).toThrow();
  });

  it("requires positive ordered command metadata and rejects extra fields", () => {
    const command = {
      handle,
      requestId: "019f644c-1379-79c0-825e-66a4b7653bd2",
      sequence: 1,
      deadlineUnixMs: Date.now() + 1_000,
      operation: "tree",
      arguments: {},
    };
    expect(RuntimeCommandSchema.parse(command)).toEqual(command);
    expect(() => RuntimeCommandSchema.parse({ ...command, sequence: 0 })).toThrow();
    expect(() => RuntimeCommandSchema.parse({ ...command, deadlineUnixMs: 0 })).toThrow();
    expect(() => RuntimeCommandSchema.parse({ ...command, unexpected: "forbidden" })).toThrow();
  });

  it("rejects expired, mismatched, and replayed one-use descriptors without residue", async () => {
    const project = await copyFixture();
    const previousRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = join(project.root, "runtime");
    try {
      const identity = await readProjectIdentity(project.root);
      const input = {
        project: identity,
        sessionId: "session_12345678",
        runId: "019f644c-1379-79c0-825e-66a4b7653bd3",
        generation: 1,
        scenePath: "res://runtime/runtime_fixture.tscn",
        now: 1,
      };

      const expired = await createRuntimeDescriptor(input);
      await expect(consumeRuntimeDescriptor(expired.path, { ...input, now: 60_002 })).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
      await expect(access(expired.path)).rejects.toThrow();
      await expired.cleanup();

      const mismatch = await createRuntimeDescriptor({ ...input, runId: "019f644c-1379-79c0-825e-66a4b7653bd4" });
      await expect(consumeRuntimeDescriptor(mismatch.path, { ...input, sessionId: "session_wrong_1234" })).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
      await expect(consumeRuntimeDescriptor(mismatch.path, input)).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
      await mismatch.cleanup();

      expect(await readdir(join(project.root, "runtime/godot-mcp"))).toEqual([]);
    } finally {
      if (previousRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previousRuntimeDirectory;
      await project.cleanup();
    }
  });
});
