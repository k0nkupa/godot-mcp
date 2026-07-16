import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { INPUT_POLICY, JsonlAuditSink, SessionService } from "@godot-mcp/control-plane";

import { executeTool } from "./executeTool.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("uses a redacted audit argument override without changing handler input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "godot-mcp-execute-tool-"));
  cleanups.push(async () => rm(directory, { force: true, recursive: true }));
  const project = { projectId: "019f644c-1379-79c0-825e-66a4b7653bd1", rootRealPath: directory, projectConfigSha256: "a".repeat(64) };
  const grants = { tiers: ["observe", "runtime_control"] as const, packs: ["core", "input"] as const };
  const auditPath = join(directory, "audit.jsonl");
  const rawArguments = { operation: "send", action: "private_action", keycode: 65, position: { x: 44, y: 55 } };
  const summary = { operation: "send", eventCount: 1, eventKinds: { action: 1 }, traceSha256: "a".repeat(64) };
  let handlerSawRaw = false;
  const session = new SessionService(project, { tiers: [...grants.tiers], packs: [...grants.packs] }, async () => ({ healthy: true, checks: [] }));

  await executeTool(
    { project, grants: { tiers: [...grants.tiers], packs: [...grants.packs] }, audit: new JsonlAuditSink(auditPath), session },
    INPUT_POLICY,
    rawArguments,
    () => {
      handlerSawRaw = rawArguments.action === "private_action";
      return { data: { accepted: true } };
    },
    { auditArguments: summary },
  );

  expect(handlerSawRaw).toBe(true);
  const audit = await readFile(auditPath, "utf8");
  expect(audit).toContain("traceSha256");
  expect(audit).not.toContain("private_action");
  expect(audit).not.toContain("keycode");
  expect(audit).not.toContain("\"x\":44");
});
