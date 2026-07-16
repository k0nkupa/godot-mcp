import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EvidenceStore, JsonlAuditSink, SessionService, type SessionGrants } from "@godot-mcp/control-plane";
import type { EditorMutationInput, EditorMutationResult } from "@godot-mcp/protocol";

import { createGodotMcpServer } from "./createServer.js";

const cleanups: Array<() => Promise<void>> = [];
const scenePath = "res://mutation/editor_mutation.tscn";
const actionId = "019f6f52-6b15-7e21-bda3-202122232425";
const planDigest = "a".repeat(64);
const idempotencyKey = "019f6f52-6b15-7e21-bda3-101112131415";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function mutationResult(input: EditorMutationInput): EditorMutationResult {
  const state = input.operation === "preview" ? "previewed" : input.operation === "apply" ? "applied" : input.operation === "undo" ? "undone" : "redone";
  const resultActionId = input.operation === "preview"
    ? undefined
    : input.operation === "apply"
      ? actionId
      : input.actionId;
  return {
    state,
    ...(resultActionId === undefined ? {} : { actionId: resultActionId }),
    planDigest,
    history: { kind: "scene", scenePath },
    preconditions: [],
    changes: [{
      operation: "rename_node",
      target: { kind: "node", path: "Target", revision: "b".repeat(64) },
      beforeRevision: "b".repeat(64),
      afterRevision: "c".repeat(64),
    }],
    warnings: ["saved"],
    audit: {
      targetIdentities: [{ kind: "node", path: "Target", revision: "c".repeat(64) }],
      preconditions: [],
      idempotencyKeySha256: state === "previewed" ? null : "d".repeat(64),
      partialEffects: false,
      rollback: "not_needed",
    },
  };
}

async function fixture(grants: SessionGrants) {
  const directory = await mkdtemp(join(tmpdir(), "godot-mcp-editor-tools-"));
  cleanups.push(async () => rm(directory, { force: true, recursive: true }));
  const project = { projectId: actionId, rootRealPath: directory, projectConfigSha256: "a".repeat(64) };
  const auditPath = join(directory, "audit.jsonl");
  const session = new SessionService(project, grants, async () => ({ healthy: true, checks: [] }));
  const execute = vi.fn(async (input: EditorMutationInput) => mutationResult(input));
  const server = createGodotMcpServer({
    project,
    grants,
    audit: new JsonlAuditSink(auditPath),
    session,
    bridge: () => null,
    evidence: new EvidenceStore(directory),
    editor: { execute },
  });
  const client = new Client({ name: "phase-5-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(async () => Promise.all([client.close(), server.close()]).then(() => undefined));
  return { auditPath, client, execute };
}

describe("editor MCP tool", () => {
  it.each([
    [{ tiers: ["observe"], packs: ["core"] }, false],
    [{ tiers: ["observe", "project_mutate"], packs: ["core"] }, false],
    [{ tiers: ["observe"], packs: ["core", "editor"] }, false],
    [{ tiers: ["observe", "project_mutate"], packs: ["core", "editor"] }, true],
  ] as const)("uses exact editor grants %j", async (grants, visible) => {
    const { client } = await fixture({ tiers: [...grants.tiers], packs: [...grants.packs] });
    const tools = (await client.listTools()).tools;
    expect(tools.some((tool) => tool.name === "godot_editor")).toBe(visible);
    expect(tools).toHaveLength(visible ? 7 : 6);
    if (visible) expect(tools.find((tool) => tool.name === "godot_editor")?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("returns mutation facts and audits only a bounded summary", async () => {
    const { auditPath, client, execute } = await fixture({ tiers: ["observe", "project_mutate"], packs: ["core", "editor"] });
    const input = {
      operation: "apply" as const,
      idempotencyKey,
      expectedPlanDigest: planDigest,
      steps: [{ operation: "set_property" as const, scenePath, nodePath: "Target", property: "secret_value", value: "do-not-audit" }],
    };
    const output = await client.callTool({ name: "godot_editor", arguments: input });
    expect(output.structuredContent).toMatchObject({ ok: true, data: { state: "applied" }, warnings: ["saved"], changes: [{ operation: "rename_node" }] });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ operation: "apply" }), expect.any(String));
    const audit = await readFile(auditPath, "utf8");
    expect(audit).not.toContain(idempotencyKey);
    expect(audit).not.toContain("do-not-audit");
    expect(audit).toContain('"stepOperations":{"set_property":1}');
    expect(audit).toContain('"idempotencyKeySha256"');
  });
});
