import { expect, it, vi } from "vitest";

import { ProjectService } from "./projectService.js";

it("dispatches project mutations and job lifecycle operations without exposing raw idempotency keys", async () => {
  const mutationResult = { operation: "plugin_set", pluginSha256: "a".repeat(64), enabled: true, rollback: "not_needed" } as const;
  const mutations = { execute: vi.fn(async () => mutationResult) };
  const jobs = {
    start: vi.fn(() => ({ state: "queued" })),
    status: vi.fn(() => ({ state: "running" })),
    cancel: vi.fn(() => ({ state: "running" })),
    result: vi.fn(() => ({ state: "completed", evidence: ["godot-mcp://evidence/x"] })),
  };
  const service = new ProjectService(mutations as never, jobs as never);
  const mutation = await service.execute({ operation: "plugin_set", idempotencyKey: "019f75d0-1234-7abc-8def-0123456789ab", pluginPath: "res://addons/example/plugin.cfg", expectedEnabled: false, enabled: true }, "req-1");
  expect(mutation.data).toEqual(mutationResult);
  expect(mutation.audit?.idempotencyKeySha256).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(mutation)).not.toContain("019f75d0-1234-7abc-8def-0123456789ab");
  await expect(service.execute({ operation: "run_start", headless: true, deadlineMs: 1_000 }, "req-2")).resolves.toEqual({ data: { state: "queued" } });
  await expect(service.execute({ operation: "job_status", jobToken: `pjob_${"A".repeat(43)}` }, "req-3")).resolves.toEqual({ data: { state: "running" } });
});
