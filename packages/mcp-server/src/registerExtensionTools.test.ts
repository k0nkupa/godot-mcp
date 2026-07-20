import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { expect, it } from "vitest";
import { CORE_QUERY_POLICY, EvidenceStore, ExtensionRegistry, JsonlAuditSink, SessionService } from "@godot-mcp/control-plane";
import { createGodotMcpServer } from "./createServer.js";

it("runs a typed extension through authorization/audit with an exact frozen least-authority context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "godot-mcp-extension-tool-"));
  const project = { projectId: "019f75d0-1234-7abc-8def-0123456789ab", rootRealPath: directory, projectConfigSha256: "a".repeat(64) };
  const grants = { tiers: ["observe"] as const, packs: ["core"] as const }; const evidence = new EvidenceStore(directory); const registry = new ExtensionRegistry(); let contextKeys: string[] = [];
  registry.register({ extension: "fixture", operation: "double", policy: CORE_QUERY_POLICY, inputSchema: z.object({ value: z.number().int() }).strict(), outputSchema: z.object({ value: z.number().int() }).strict(), audit: (input) => ({ magnitude: input.value }), handler: async (context, input) => { contextKeys = Object.keys(context).sort(); expect(Object.isFrozen(context)).toBe(true); expect(Object.isFrozen(context.project)).toBe(true); return { value: input.value * 2 }; } });
  const session = new SessionService(project, { tiers: [...grants.tiers], packs: [...grants.packs] }, async () => ({ healthy: true, checks: [] })); const auditPath = join(directory, "audit.jsonl");
  const server = createGodotMcpServer({ project, grants: { tiers: [...grants.tiers], packs: [...grants.packs] }, session, audit: new JsonlAuditSink(auditPath), bridge: () => null, evidence, extensions: registry, extensionContext: (correlationId) => ({ project, correlationId, evidence: { putJson: async (value, metadata) => (await evidence.putJson("session_12345678", value, metadata)).observationUri } }) });
  const client = new Client({ name: "extension-test", version: "1" }); const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("godot_extension");
    const result = await client.callTool({ name: "godot_extension", arguments: { extension: "fixture", operation: "double", input: { value: 4 } } });
    expect(result.structuredContent).toMatchObject({ ok: true, data: { value: 8 } });
    expect(contextKeys).toEqual(["correlationId", "evidence", "project"]);
    expect(await readFile(auditPath, "utf8")).toContain('"magnitude":4');
  } finally { await Promise.allSettled([client.close(), server.close()]); await rm(directory, { recursive: true, force: true }); }
});
