import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  JsonlAuditSink,
  SessionService,
  type SessionGrants,
} from "@godot-mcp/control-plane";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGodotMcpServer } from "./index.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function testServer() {
  const directory = await mkdtemp(join(tmpdir(), "godot-mcp-tools-"));
  cleanups.push(async () => rm(directory, { force: true, recursive: true }));
  const project = {
    projectId: "019f644c-1379-79c0-825e-66a4b7653bd1",
    rootRealPath: "/tmp/project",
    projectConfigSha256: "a".repeat(64),
  };
  const grants: SessionGrants = { tiers: ["observe"], packs: ["core"] };
  const audit = new JsonlAuditSink(join(directory, "audit.jsonl"));
  const session = new SessionService(project, grants, async () => ({
    healthy: true,
    checks: [{ name: "installation", status: "ok", detail: "installed" }],
  }));
  return {
    auditPath: join(directory, "audit.jsonl"),
    server: createGodotMcpServer({ project, grants, audit, session }),
  };
}

describe("Phase 1 MCP tools", () => {
  it("registers only the four read-only tools", async () => {
    const { server } = await testServer();
    const client = new Client({ name: "phase-1-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "godot_capabilities",
      "godot_doctor",
      "godot_help",
      "godot_session",
    ]);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.every((tool) => tool.annotations?.destructiveHint === false)).toBe(true);
    expect(tools.every((tool) => tool.annotations?.openWorldHint === false)).toBe(true);
    await Promise.all([client.close(), server.close()]);
  });

  it("returns structured content and audits invalid help topics", async () => {
    const { server } = await testServer();
    const client = new Client({ name: "phase-1-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const sessionResult = await client.callTool({ name: "godot_session", arguments: {} });
    expect(sessionResult.isError).not.toBe(true);
    expect(sessionResult.structuredContent).toMatchObject({ ok: true });

    const invalid = await client.callTool({ name: "godot_help", arguments: { operation: "shell" } });
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toMatchObject({
      ok: false,
      data: { error: { code: "TARGET_NOT_FOUND" } },
    });
    await Promise.all([client.close(), server.close()]);
  });
});
