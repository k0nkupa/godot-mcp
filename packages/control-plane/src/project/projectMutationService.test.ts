import { createHash } from "node:crypto";
import { join } from "node:path";

import { copyFixture } from "@godot-mcp/testkit";
import { canonicalFloat64Le, canonicalJson, type ProjectMutationResult, type ProjectOperationInput } from "@godot-mcp/protocol";
import { describe, expect, it } from "vitest";

import { ProjectMutationJournal, ProjectMutationService } from "./projectMutationService.js";

const key = "019f75d0-1234-7abc-8def-0123456789ab";
const input: Extract<ProjectOperationInput, { operation: "settings_apply" }> = { operation: "settings_apply", idempotencyKey: key, changes: [{ name: "application/config/name", expectedValue: "old", value: "new" }] };
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const result: ProjectMutationResult = {
  operation: "settings_apply",
  changes: [{ settingNameSha256: sha256("application/config/name"), preimageSha256: sha256(JSON.stringify("old")), postimageSha256: sha256(JSON.stringify("new")) }],
  rollback: "not_needed",
};

describe("ProjectMutationService", () => {
  it("journals a mutation and replays its hash-only receipt without a second bridge call", async () => {
    const project = await copyFixture();
    let calls = 0;
    try {
      const journalPath = join(project.root, ".godot/evidence/godot-mcp/project-mutation-journal.jsonl");
      const service = new ProjectMutationService(() => ({ request: async () => { calls += 1; return { data: result }; } }), await ProjectMutationJournal.open(journalPath));
      await expect(service.execute(input, "req-1")).resolves.toEqual(result);
      const reopened = new ProjectMutationService(() => null, await ProjectMutationJournal.open(journalPath));
      await expect(reopened.execute(input, "req-2")).resolves.toEqual(result);
      expect(calls).toBe(1);
    } finally { await project.cleanup(); }
  });

  it("fails closed on an unknown outcome and key reuse with another request", async () => {
    const project = await copyFixture();
    try {
      const journal = await ProjectMutationJournal.open(join(project.root, "journal.jsonl"));
      const failing = new ProjectMutationService(() => ({ request: async () => { throw new Error("transport lost"); } }), journal);
      await expect(failing.execute(input, "req-1")).rejects.toThrow("transport lost");
      await expect(failing.execute(input, "req-2")).rejects.toThrow(/unknown outcome/i);
      await expect(failing.execute({ ...input, changes: [{ name: "application/config/name", expectedValue: "old", value: "different" }] }, "req-3")).rejects.toThrow(/another project mutation/i);
    } finally { await project.cleanup(); }
  });

  it("rejects a mismatched receipt and leaves an unknown journal state", async () => {
    const project = await copyFixture();
    try {
      const journal = await ProjectMutationJournal.open(join(project.root, "journal.jsonl"));
      const service = new ProjectMutationService(() => ({ request: async () => ({ data: { ...result, changes: [] } }) }), journal);
      await expect(service.execute(input, "req-1")).rejects.toThrow();
      await expect(service.execute(input, "req-2")).rejects.toThrow(/unknown outcome/i);
    } finally { await project.cleanup(); }
  });

  it("serializes concurrent retries so one idempotency key dispatches once", async () => {
    const project = await copyFixture();
    let calls = 0;
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const requestEntered = new Promise<void>((resolve) => { entered = resolve; });
    try {
      const journal = await ProjectMutationJournal.open(join(project.root, "journal.jsonl"));
      const service = new ProjectMutationService(() => ({ request: async () => {
        calls += 1;
        entered();
        await pending;
        return { data: result };
      } }), journal);
      const first = service.execute(input, "req-1");
      const retry = service.execute(input, "req-2");
      await requestEntered;
      const callsBeforeRelease = calls;
      release();
      await expect(Promise.all([first, retry])).resolves.toEqual([result, result]);
      expect(callsBeforeRelease).toBe(1);
      expect(calls).toBe(1);
    } finally { await project.cleanup(); }
  });

  it("rejects receipts that do not match the requested target or value", async () => {
    const project = await copyFixture();
    try {
      const journal = await ProjectMutationJournal.open(join(project.root, "journal.jsonl"));
      const mismatched = { ...result, changes: [{ ...result.changes[0]!, postimageSha256: "d".repeat(64) }] };
      const service = new ProjectMutationService(() => ({ request: async () => ({ data: mismatched }) }), journal);
      await expect(service.execute(input, "req-1")).rejects.toThrow(/mismatched project mutation receipt/i);
    } finally { await project.cleanup(); }
  });

  it("verifies floating-point receipts with the shared bridge encoding", async () => {
    const project = await copyFixture();
    const floatInput: Extract<ProjectOperationInput, { operation: "settings_apply" }> = { operation: "settings_apply", idempotencyKey: key, changes: [{ name: "physics/common/physics_ticks_per_second", expectedValue: 1.5, value: 2.5 }] };
    const digest = (value: number): string => sha256(canonicalJson({ $godotMcpFloat64Le: canonicalFloat64Le(value) }));
    const floatResult: ProjectMutationResult = {
      operation: "settings_apply",
      changes: [{ settingNameSha256: sha256("physics/common/physics_ticks_per_second"), preimageSha256: digest(1.5), postimageSha256: digest(2.5) }],
      rollback: "not_needed",
    };
    try {
      const journal = await ProjectMutationJournal.open(join(project.root, "journal.jsonl"));
      const service = new ProjectMutationService(() => ({ request: async () => ({ data: floatResult }) }), journal);
      await expect(service.execute(floatInput, "req-1")).resolves.toEqual(floatResult);
    } finally { await project.cleanup(); }
  });
});
