import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { EDITOR_POLICY, INPUT_POLICY, JsonlAuditSink, SessionService } from "@godot-mcp/control-plane";

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

it("returns and audits mutation warnings changes and rollback facts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "godot-mcp-execute-mutation-"));
  cleanups.push(async () => rm(directory, { force: true, recursive: true }));
  const project = { projectId: "019f644c-1379-79c0-825e-66a4b7653bd1", rootRealPath: directory, projectConfigSha256: "a".repeat(64) };
  const grants = { tiers: ["observe", "project_mutate"] as const, packs: ["core", "editor"] as const };
  const auditPath = join(directory, "audit.jsonl");
  const session = new SessionService(project, { tiers: [...grants.tiers], packs: [...grants.packs] }, async () => ({ healthy: true, checks: [] }));
  const facts = {
    targetIdentities: [{ kind: "node", path: "Target" }],
    preconditions: [{ path: "Target", expectedRevision: "a".repeat(64) }],
    idempotencyKeySha256: "b".repeat(64),
    partialEffects: false,
    rollback: "succeeded" as const,
  };
  const output = await executeTool(
    { project, grants: { tiers: [...grants.tiers], packs: [...grants.packs] }, audit: new JsonlAuditSink(auditPath), session },
    EDITOR_POLICY,
    { operation: "apply" },
    () => ({ data: { state: "applied" }, warnings: ["saved"], changes: [{ operation: "rename_node" }], audit: facts }),
  );
  expect(output.result).toMatchObject({ warnings: ["saved"], changes: [{ operation: "rename_node" }] });
  expect(JSON.parse((await readFile(auditPath, "utf8")).trim())).toMatchObject({
    targetIdentities: facts.targetIdentities,
    idempotencyKeySha256: facts.idempotencyKeySha256,
    rollback: "succeeded",
    changes: [{ operation: "rename_node" }],
  });
});
