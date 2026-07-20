import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it } from "vitest";

import { EvidenceStore, JsonlAuditSink, SessionService, type SessionGrants } from "@godot-mcp/control-plane";
import type { ProjectOperationInput } from "@godot-mcp/protocol";

import { createGodotMcpServer } from "./createServer.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(grants: SessionGrants) {
  const directory = await mkdtemp(join(tmpdir(), "godot-mcp-project-tools-"));
  cleanups.push(async () => rm(directory, { force: true, recursive: true }));
  const projectIdentity = { projectId: "019f75d0-1234-7abc-8def-0123456789ab", rootRealPath: directory, projectConfigSha256: "a".repeat(64) };
  const auditPath = join(directory, "audit.jsonl");
  const session = new SessionService(projectIdentity, grants, async () => ({ healthy: true, checks: [] }));
  session.onAttached({ sessionId: "session_12345678", godotVersion: "4.7.stable.official.test", addonVersion: "0.1.0", addonManifestSha256: "b".repeat(64), attachedAt: "2026-07-18T00:00:00.000Z" });
  const calls: ProjectOperationInput[] = [];
  const project = { execute: async (input: ProjectOperationInput) => { calls.push(input); return { data: { operation: input.operation } }; } };
  const server = createGodotMcpServer({
    project: projectIdentity,
    grants,
    audit: new JsonlAuditSink(auditPath),
    session,
    bridge: () => null,
    evidence: new EvidenceStore(directory),
    projectOperations: project,
  });
  const client = new Client({ name: "phase-9-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(async () => Promise.all([client.close(), server.close()]).then(() => undefined));
  return { auditPath, calls, client };
}

it.each([
  [{ tiers: ["observe"], packs: ["core"] }, 6],
  [{ tiers: ["observe", "project_operate"], packs: ["core"] }, 6],
  [{ tiers: ["observe"], packs: ["core", "project"] }, 6],
  [{ tiers: ["observe", "project_operate"], packs: ["core", "project"] }, 7],
] as const)("registers project operations only for complete grants %j", async (grants, expectedCount) => {
  const { client } = await fixture({ tiers: [...grants.tiers], packs: [...grants.packs] });
  const tools = (await client.listTools()).tools;
  expect(tools).toHaveLength(expectedCount);
  expect(tools.some((tool) => tool.name === "godot_project")).toBe(expectedCount === 7);
});

it("forwards strict operations and audits hashes/counts without values, paths, presets, or tokens", async () => {
  const { auditPath, calls, client } = await fixture({ tiers: ["observe", "project_operate"], packs: ["core", "project"] });
  await client.callTool({ name: "godot_project", arguments: {
    operation: "settings_apply",
    idempotencyKey: "019f75d0-1234-7abc-8def-0123456789ab",
    changes: [{ name: "application/config/name", expectedValue: "old-private", value: "new-private" }],
  } });
  await client.callTool({ name: "godot_project", arguments: {
    operation: "export_start",
    preset: "private-preset",
    mode: "release",
    artifactName: "private-artifact",
  } });
  await client.callTool({ name: "godot_project", arguments: { operation: "job_status", jobToken: `pjob_${"A".repeat(43)}` } });

  expect(calls.map((call) => call.operation)).toEqual(["settings_apply", "export_start", "job_status"]);
  const audit = await readFile(auditPath, "utf8");
  expect(audit).not.toContain("old-private");
  expect(audit).not.toContain("new-private");
  expect(audit).not.toContain("private-preset");
  expect(audit).not.toContain("private-artifact");
  expect(audit).not.toContain(`pjob_${"A".repeat(43)}`);
  expect(audit).toContain(createHash("sha256").update("private-preset").digest("hex"));
  expect(audit).toContain('"settingCount":1');
});
