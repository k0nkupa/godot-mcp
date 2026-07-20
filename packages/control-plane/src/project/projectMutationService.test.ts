import { join } from "node:path";

import { copyFixture } from "@godot-mcp/testkit";
import type { ProjectMutationResult, ProjectOperationInput } from "@godot-mcp/protocol";
import { describe, expect, it } from "vitest";

import { ProjectMutationJournal, ProjectMutationService } from "./projectMutationService.js";

const key = "019f75d0-1234-7abc-8def-0123456789ab";
const input: Extract<ProjectOperationInput, { operation: "settings_apply" }> = { operation: "settings_apply", idempotencyKey: key, changes: [{ name: "application/config/name", expectedValue: "old", value: "new" }] };
const result: ProjectMutationResult = {
  operation: "settings_apply",
  changes: [{ settingNameSha256: "a".repeat(64), preimageSha256: "b".repeat(64), postimageSha256: "c".repeat(64) }],
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
});
