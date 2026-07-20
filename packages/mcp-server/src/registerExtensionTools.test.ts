import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { expect, it } from "vitest";
import { CORE_QUERY_POLICY, EDITOR_POLICY, EvidenceStore, ExtensionRegistry, JsonlAuditSink, SessionService } from "@godot-mcp/control-plane";
import { createGodotMcpServer } from "./createServer.js";

it("runs a typed extension through authorization/audit with an exact frozen least-authority context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "godot-mcp-extension-tool-"));
  const project = { projectId: "019f75d0-1234-7abc-8def-0123456789ab", rootRealPath: directory, projectConfigSha256: "a".repeat(64) };
  const grants = { tiers: ["observe"] as const, packs: ["core"] as const }; const evidence = new EvidenceStore(directory); const registry = new ExtensionRegistry(); let contextKeys: string[] = [];
  registry.register({ extension: "fixture", operation: "double", policy: CORE_QUERY_POLICY, inputSchema: z.object({ value: z.number().int() }).strict(), outputSchema: z.object({ value: z.number().int() }).strict(), audit: (input) => ({ magnitude: input.value }), handler: async (context, input) => { contextKeys = Object.keys(context).sort(); expect(Object.isFrozen(context)).toBe(true); expect(Object.isFrozen(context.project)).toBe(true); return { value: input.value * 2 }; } });
  registry.register({ extension: "fixture", operation: "no_input", policy: CORE_QUERY_POLICY, inputSchema: z.null(), outputSchema: z.object({ accepted: z.literal(true) }).strict(), audit: () => ({}), handler: async () => ({ accepted: true as const }) });
  const session = new SessionService(project, { tiers: [...grants.tiers], packs: [...grants.packs] }, async () => ({ healthy: true, checks: [] })); const auditPath = join(directory, "audit.jsonl");
  const server = createGodotMcpServer({ project, grants: { tiers: [...grants.tiers], packs: [...grants.packs] }, session, audit: new JsonlAuditSink(auditPath), bridge: () => null, evidence, extensions: registry, extensionContext: (correlationId) => ({ project, correlationId, evidence: { putJson: async (value, metadata) => (await evidence.putJson("session_12345678", value, metadata)).observationUri } }) });
  const client = new Client({ name: "extension-test", version: "1" }); const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("godot_extension");
    const result = await client.callTool({ name: "godot_extension", arguments: { extension: "fixture", operation: "double", input: { value: 4 } } });
    expect(result.structuredContent).toMatchObject({ ok: true, data: { value: 8 } });
    expect((await client.callTool({ name: "godot_extension", arguments: { extension: "fixture", operation: "no_input", input: null } })).structuredContent).toMatchObject({ ok: true, data: { accepted: true } });
    expect(contextKeys).toEqual(["correlationId", "evidence", "project"]);
    expect(await readFile(auditPath, "utf8")).toContain('"magnitude":4');
  } finally { await Promise.allSettled([client.close(), server.close()]); await rm(directory, { recursive: true, force: true }); }
});

it("audits extension audit-hook failures without allowing reserved identity overrides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "godot-mcp-extension-audit-"));
  const project = { projectId: "019f75d0-1234-7abc-8def-0123456789ab", rootRealPath: directory, projectConfigSha256: "a".repeat(64) };
  const grants = { tiers: ["observe"] as const, packs: ["core"] as const }; const registry = new ExtensionRegistry();
  registry.register({ extension: "fixture", operation: "reject_audit", policy: CORE_QUERY_POLICY, inputSchema: z.object({}).strict(), outputSchema: z.null(), audit: () => ({ extension: "forged" }), handler: async () => null });
  const session = new SessionService(project, { tiers: [...grants.tiers], packs: [...grants.packs] }, async () => ({ healthy: true, checks: [] })); const auditPath = join(directory, "audit.jsonl");
  const server = createGodotMcpServer({ project, grants: { tiers: [...grants.tiers], packs: [...grants.packs] }, session, audit: new JsonlAuditSink(auditPath), bridge: () => null, evidence: new EvidenceStore(directory), extensions: registry, extensionContext: (correlationId) => ({ project, correlationId, evidence: { putJson: async () => "godot-mcp:unused" } }) });
  const client = new Client({ name: "extension-audit-test", version: "1" }); const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: "godot_extension", arguments: { extension: "fixture", operation: "reject_audit", input: {} } });
    expect(result.structuredContent).toMatchObject({ ok: false, data: { error: { code: "INVALID_REQUEST" } } });
    const record = JSON.parse((await readFile(auditPath, "utf8")).trim()) as { outcome: string; arguments: unknown };
    expect(record).toMatchObject({ outcome: "error", arguments: { extension: "fixture", operation: "reject_audit" } });
  } finally { await Promise.allSettled([client.close(), server.close()]); await rm(directory, { recursive: true, force: true }); }
});

it("authorizes before extension validation and audits only operation identity on denial", async () => {
  const directory = await mkdtemp(join(tmpdir(), "godot-mcp-extension-auth-"));
  const project = { projectId: "019f75d0-1234-7abc-8def-0123456789ab", rootRealPath: directory, projectConfigSha256: "a".repeat(64) };
  const grants = { tiers: ["observe"] as const, packs: ["core"] as const }; const registry = new ExtensionRegistry(); let refinements = 0;
  registry.register({ extension: "fixture", operation: "visible", policy: CORE_QUERY_POLICY, inputSchema: z.object({}).strict(), outputSchema: z.null(), audit: () => ({}), handler: async () => null });
  registry.register({ extension: "fixture", operation: "mutate", policy: EDITOR_POLICY, inputSchema: z.object({ secret: z.string().refine(() => { refinements += 1; return true; }) }).strict(), outputSchema: z.null(), audit: () => ({}), handler: async () => null });
  const session = new SessionService(project, { tiers: [...grants.tiers], packs: [...grants.packs] }, async () => ({ healthy: true, checks: [] })); const auditPath = join(directory, "audit.jsonl");
  const server = createGodotMcpServer({ project, grants: { tiers: [...grants.tiers], packs: [...grants.packs] }, session, audit: new JsonlAuditSink(auditPath), bridge: () => null, evidence: new EvidenceStore(directory), extensions: registry, extensionContext: (correlationId) => ({ project, correlationId, evidence: { putJson: async () => "godot-mcp:unused" } }) });
  const client = new Client({ name: "extension-auth-test", version: "1" }); const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: "godot_extension", arguments: { extension: "fixture", operation: "mutate", input: { secret: "PRIVATE_EXTENSION_INPUT" } } });
    expect(result.structuredContent).toMatchObject({ ok: false, data: { error: { code: "PERMISSION_REQUIRED" } } });
    expect(refinements).toBe(0);
    const audit = await readFile(auditPath, "utf8"); expect(audit).not.toContain("PRIVATE_EXTENSION_INPUT"); expect(audit).toContain('"operation":"mutate"');
  } finally { await Promise.allSettled([client.close(), server.close()]); await rm(directory, { recursive: true, force: true }); }
});

it("rejects non-JSON extension audit metadata and output through the audited error path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "godot-mcp-extension-json-")); const project = { projectId: "019f75d0-1234-7abc-8def-0123456789ab", rootRealPath: directory, projectConfigSha256: "a".repeat(64) }; const grants = { tiers: ["observe"] as const, packs: ["core"] as const }; const registry = new ExtensionRegistry();
  registry.register({ extension: "fixture", operation: "bad_audit", policy: CORE_QUERY_POLICY, inputSchema: z.null(), outputSchema: z.null(), audit: () => ({ toJSON: () => undefined }), handler: async () => null });
  registry.register({ extension: "fixture", operation: "bad_output", policy: CORE_QUERY_POLICY, inputSchema: z.null(), outputSchema: z.undefined(), audit: () => ({}), handler: async () => undefined });
  const session = new SessionService(project, { tiers: [...grants.tiers], packs: [...grants.packs] }, async () => ({ healthy: true, checks: [] })); const auditPath = join(directory, "audit.jsonl"); const server = createGodotMcpServer({ project, grants: { tiers: [...grants.tiers], packs: [...grants.packs] }, session, audit: new JsonlAuditSink(auditPath), bridge: () => null, evidence: new EvidenceStore(directory), extensions: registry, extensionContext: (correlationId) => ({ project, correlationId, evidence: { putJson: async () => "godot-mcp:unused" } }) }); const client = new Client({ name: "extension-json-test", version: "1" }); const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    for (const operation of ["bad_audit", "bad_output"]) expect((await client.callTool({ name: "godot_extension", arguments: { extension: "fixture", operation, input: null } })).structuredContent).toMatchObject({ ok: false, data: { error: { code: "INVALID_REQUEST" } } });
    expect((await readFile(auditPath, "utf8")).trim().split("\n")).toHaveLength(2);
  } finally { await Promise.allSettled([client.close(), server.close()]); await rm(directory, { recursive: true, force: true }); }
});
