import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it } from "vitest";

import { EvidenceStore, JsonlAuditSink, SessionService } from "@godot-mcp/control-plane";

import { createGodotMcpServer } from "./createServer.js";

const cleanups: Array<() => Promise<void>> = [];
const handle = { runId: "019f644c-1379-79c0-825e-66a4b7653bd1", generation: 1 };
const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const sha256 = createHash("sha256").update(png).digest("hex");

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "godot-mcp-runtime-tools-"));
  cleanups.push(async () => rm(directory, { force: true, recursive: true }));
  const project = { projectId: handle.runId, rootRealPath: directory, projectConfigSha256: "a".repeat(64) };
  const grants = { tiers: ["observe", "runtime_control"] as const, packs: ["core", "runtime"] as const };
  const auditPath = join(directory, "audit.jsonl");
  const audit = new JsonlAuditSink(auditPath);
  const session = new SessionService(project, { tiers: [...grants.tiers], packs: [...grants.packs] }, async () => ({ healthy: true, checks: [] }));
  session.onAttached({ sessionId: "session_12345678", godotVersion: "4.7.stable.official.test", addonVersion: "0.1.0", addonManifestSha256: "b".repeat(64), attachedAt: "2026-07-16T00:00:00.000Z" });
  const runtime = {
    launch: async () => ({ handle, root: { pid: 42, scenePath: "res://runtime/runtime_fixture.tscn" } }),
    execute: async (input: { operation: string }) => ({ operation: input.operation, state: "running" }),
    capture: async (input: { frameCount: number }) => ({
      frames: Array.from({ length: input.frameCount }, (_, frameIndex) => ({
        data: png,
        metadata: { mimeType: "image/png" as const, width: 1, height: 1, byteLength: png.length, sha256, frameIndex },
      })),
    }),
  };
  const server = createGodotMcpServer({ project, grants: { tiers: [...grants.tiers], packs: [...grants.packs] }, audit, session, bridge: () => null, evidence: new EvidenceStore(directory), runtime });
  const client = new Client({ name: "phase-3-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(async () => Promise.all([client.close(), server.close()]).then(() => undefined));
  return { auditPath, client };
}

it("registers runtime tools only for the explicit runtime grants", async () => {
  const { client } = await fixture();
  const tools = (await client.listTools()).tools;
  expect(tools.map((tool) => tool.name).sort()).toEqual([
    "godot_capabilities", "godot_capture", "godot_doctor", "godot_help", "godot_query", "godot_runtime", "godot_runtime_capture", "godot_session",
  ]);
  expect(tools.find((tool) => tool.name === "godot_runtime_capture")?.annotations).toMatchObject({ readOnlyHint: false });
  const launch = await client.callTool({ name: "godot_runtime", arguments: { operation: "launch", scenePath: "res://runtime/runtime_fixture.tscn" } });
  expect(launch.structuredContent).toMatchObject({ ok: true, data: { handle, root: { pid: 42 } } });
});

it("returns ordered runtime images without putting bytes in structured or audit output", async () => {
  const { auditPath, client } = await fixture();
  const capture = await client.callTool({ name: "godot_runtime_capture", arguments: { handle, frameCount: 2, maxWidth: 640, maxHeight: 360 } });
  const content = capture.content as Array<{ type: string; data?: string; mimeType?: string }>;
  expect(content.filter((item) => item.type === "image")).toEqual([
    { type: "image", data: png.toString("base64"), mimeType: "image/png" },
    { type: "image", data: png.toString("base64"), mimeType: "image/png" },
  ]);
  expect(capture.structuredContent).toMatchObject({ ok: true, data: { frames: [{ frameIndex: 0 }, { frameIndex: 1 }] } });
  expect(JSON.stringify(capture.structuredContent)).not.toContain(png.toString("base64"));
  expect(await readFile(auditPath, "utf8")).not.toContain(png.toString("base64"));
});
