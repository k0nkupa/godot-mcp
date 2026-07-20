import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { EvidenceStore, JsonlAuditSink, SessionService } from "@godot-mcp/control-plane";
import { createGodotMcpServer } from "./createServer.js";

it("registers one visibly unsandboxed tool only with complete grants and hashes source in audit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "godot-mcp-unsafe-tool-"));
  const project = { projectId: "019f75d0-1234-7abc-8def-0123456789ab", rootRealPath: directory, projectConfigSha256: "a".repeat(64) };
  const grants = { tiers: ["observe", "unsafe_fixture"] as const, packs: ["core", "unsafe"] as const };
  const session = new SessionService(project, { tiers: [...grants.tiers], packs: [...grants.packs] }, async () => ({ healthy: true, checks: [] }));
  const auditPath = join(directory, "audit.jsonl");
  const server = createGodotMcpServer({ project, grants: { tiers: [...grants.tiers], packs: [...grants.packs] }, session, audit: new JsonlAuditSink(auditPath), bridge: () => null, evidence: new EvidenceStore(directory), unsafeFixture: { execute: async () => ({ data: { unsafe: true, sandboxed: false } }) } });
  const client = new Client({ name: "unsafe-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(7);
    expect(tools.find((tool) => tool.name === "godot_unsafe_fixture")?.description).toMatch(/not a sandbox/i);
    await client.callTool({ name: "godot_unsafe_fixture", arguments: { operation: "execute_start", source: "PRIVATE_SOURCE", deadlineMs: 100 } });
    const audit = await import("node:fs/promises").then(({ readFile }) => readFile(auditPath, "utf8"));
    expect(audit).not.toContain("PRIVATE_SOURCE");
    expect(audit).toContain('"sandboxed":false');
  } finally { await Promise.allSettled([client.close(), server.close()]); await rm(directory, { recursive: true, force: true }); }
});
