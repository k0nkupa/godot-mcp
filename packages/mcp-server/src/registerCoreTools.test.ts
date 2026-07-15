import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  EvidenceStore,
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

async function testServer(options: { attached?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "godot-mcp-tools-"));
  cleanups.push(async () => rm(directory, { force: true, recursive: true }));
  const project = {
    projectId: "019f644c-1379-79c0-825e-66a4b7653bd1",
    rootRealPath: directory,
    projectConfigSha256: "a".repeat(64),
  };
  const grants: SessionGrants = { tiers: ["observe"], packs: ["core"] };
  const audit = new JsonlAuditSink(join(directory, "audit.jsonl"));
  const session = new SessionService(project, grants, async () => ({
    healthy: true,
    checks: [{ name: "installation", status: "ok", detail: "installed" }],
  }));
  if (options.attached) {
    session.onAttached({
      sessionId: "session_12345678",
      godotVersion: "4.7.stable.official.test",
      addonVersion: "0.1.0",
      addonManifestSha256: "b".repeat(64),
      attachedAt: "2026-07-16T00:00:00.000Z",
    });
  }
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const bridge = options.attached
    ? {
        async request<T>(method: string): Promise<{
          requestId: string;
          data: T;
          binary?: Uint8Array;
        }> {
          if (method === "editor.query") {
            return {
              requestId: "019f644c-1379-79c0-825e-66a4b7653bd2",
              data: { operation: "editor_state" } as T,
            };
          }
          return {
            requestId: "019f644c-1379-79c0-825e-66a4b7653bd3",
            data: { mimeType: "image/png", viewport: "2d", width: 1, height: 1, byteLength: png.length, sha256: "ignored" } as T,
            binary: png,
          };
        },
      }
    : null;
  return {
    auditPath: join(directory, "audit.jsonl"),
    png,
    server: createGodotMcpServer({
      project,
      grants,
      audit,
      session,
      bridge: () => bridge,
      evidence: new EvidenceStore(directory),
    }),
  };
}

describe("core MCP tools", () => {
  it("registers all six read-only tools", async () => {
    const { server } = await testServer();
    const client = new Client({ name: "phase-1-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "godot_capabilities",
      "godot_capture",
      "godot_doctor",
      "godot_help",
      "godot_query",
      "godot_session",
    ]);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.every((tool) => tool.annotations?.destructiveHint === false)).toBe(true);
    expect(tools.every((tool) => tool.annotations?.openWorldHint === false)).toBe(true);
    await Promise.all([client.close(), server.close()]);
  });

  it("returns editor queries and real image content without base64 in structured output", async () => {
    const { server, png } = await testServer({ attached: true });
    const client = new Client({ name: "phase-2-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const query = await client.callTool({
      name: "godot_query",
      arguments: { operation: "editor_state" },
    });
    expect(query.structuredContent).toMatchObject({
      ok: true,
      data: { operation: "editor_state" },
    });

    const capture = await client.callTool({
      name: "godot_capture",
      arguments: { viewport: "2d", maxWidth: 640, maxHeight: 480 },
    });
    expect(capture.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text" }),
        { type: "image", data: png.toString("base64"), mimeType: "image/png" },
      ]),
    );
    expect(capture.structuredContent).toMatchObject({
      ok: true,
      data: { mimeType: "image/png", evidenceUri: expect.stringMatching(/^godot-mcp:\/\/evidence\//) },
    });
    expect(JSON.stringify(capture.structuredContent)).not.toContain(png.toString("base64"));
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
