import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { copyFixture } from "@godot-mcp/testkit";
import { afterEach, describe, expect, it } from "vitest";

import { JsonlAuditSink, redactAuditValue, type AuditInput } from "../index.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
});

function baseRecord(overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    sessionId: "session-1234567890",
    projectId: "019f644c-1379-79c0-825e-66a4b7653bd1",
    event: "test-event",
    outcome: "success",
    permissionTier: "observe",
    arguments: {},
    errorCode: null,
    ...overrides,
  };
}

describe("JsonlAuditSink", () => {
  it("redacts nested secrets and writes complete JSONL in call order under concurrency", async () => {
    const project = await copyFixture();
    cleanups.push(project.cleanup);
    const path = join(project.root, ".godot/evidence/godot-mcp/audit.jsonl");
    const sink = new JsonlAuditSink(path);

    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        sink.append(
          baseRecord({
            event: `event-${index}`,
            arguments: { token: "secret", nested: { password: "hidden" } },
          }),
        ),
      ),
    );

    const lines = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(50);
    expect(lines.map((line) => line.event)).toEqual(
      Array.from({ length: 50 }, (_, index) => `event-${index}`),
    );
    expect(lines[0]?.arguments).toEqual({
      token: "[REDACTED]",
      nested: { password: "[REDACTED]" },
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("replaces binary data and cycles safely", () => {
    const cyclic: Record<string, unknown> = { binary: Buffer.from("abc") };
    cyclic.self = cyclic;

    expect(redactAuditValue(cyclic)).toEqual({
      binary: "[BINARY 3 bytes]",
      self: "[CIRCULAR]",
    });
  });
});
