import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it } from "vitest";

import {
  EvidenceStore,
  JsonlAuditSink,
  SessionService,
  inputTraceEvents,
  traceSha256,
  type SessionGrants,
} from "@godot-mcp/control-plane";
import type { InputOperationInput, InputOperationResult } from "@godot-mcp/protocol";

import { createGodotMcpServer } from "./createServer.js";

const cleanups: Array<() => Promise<void>> = [];
const handle = { runId: "019f644c-1379-79c0-825e-66a4b7653bd1", generation: 1 };

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function inputResult(input: InputOperationInput): InputOperationResult {
  const trace = input.operation === "record_stop"
    ? { schemaVersion: 1 as const, events: [] }
    : { schemaVersion: 1 as const, events: inputTraceEvents(input) };
  const events = trace.events.map(({ frameOffset, event }, index) => ({
    index,
    kind: event.type,
    scheduledFrame: frameOffset,
    deliveredFrame: frameOffset,
    ...("viewportPath" in event ? { viewportPath: event.viewportPath, coordinateSpace: event.coordinateSpace } : {}),
  }));
  return {
    receipt: {
      handle: input.handle,
      operation: input.operation,
      eventCount: events.length,
      deliveredCount: events.length,
      deterministic: input.operation === "replay" || (input.operation === "sequence" && input.mode === "deterministic"),
      events,
      releases: [],
      traceSha256: traceSha256(trace),
      recording: input.operation === "record_start",
    },
    ...(input.operation === "record_stop" ? { trace } : {}),
  };
}

async function fixture(grants: SessionGrants) {
  const directory = await mkdtemp(join(tmpdir(), "godot-mcp-input-tools-"));
  cleanups.push(async () => rm(directory, { force: true, recursive: true }));
  const project = { projectId: handle.runId, rootRealPath: directory, projectConfigSha256: "a".repeat(64) };
  const auditPath = join(directory, "audit.jsonl");
  const session = new SessionService(project, grants, async () => ({ healthy: true, checks: [] }));
  session.onAttached({ sessionId: "session_12345678", godotVersion: "4.7.stable.official.test", addonVersion: "0.1.0", addonManifestSha256: "b".repeat(64), attachedAt: "2026-07-16T00:00:00.000Z" });
  const runtime = {
    launch: async () => ({ handle }),
    execute: async () => ({}),
    capture: async () => ({ frames: [] }),
    input: async (input: InputOperationInput) => inputResult(input),
  };
  const server = createGodotMcpServer({
    project,
    grants,
    audit: new JsonlAuditSink(auditPath),
    session,
    bridge: () => null,
    evidence: new EvidenceStore(directory),
    runtime,
  });
  const client = new Client({ name: "phase-4-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(async () => Promise.all([client.close(), server.close()]).then(() => undefined));
  return { auditPath, client };
}

it.each([
  [{ tiers: ["observe"], packs: ["core"] }, 6],
  [{ tiers: ["observe", "runtime_control"], packs: ["core", "runtime"] }, 8],
  [{ tiers: ["observe", "runtime_control"], packs: ["core", "input"] }, 7],
  [{ tiers: ["observe", "runtime_control"], packs: ["core", "runtime", "input"] }, 9],
] as const)("registers exact tools for grants %j", async (grants, expectedCount) => {
  const { client } = await fixture({ tiers: [...grants.tiers], packs: [...grants.packs] });
  const tools = (await client.listTools()).tools;
  const hasInput = (grants.packs as readonly string[]).includes("input");
  expect(tools).toHaveLength(expectedCount);
  expect(tools.some((tool) => tool.name === "godot_input")).toBe(hasInput);
  if (hasInput) {
    expect(tools.find((tool) => tool.name === "godot_input")?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  }
});

it("returns bounded receipts for every operation and writes only an audit summary", async () => {
  const { auditPath, client } = await fixture({ tiers: ["observe", "runtime_control"], packs: ["core", "input"] });
  const calls = [
    { operation: "record_start", handle },
    { operation: "send", handle, event: { type: "action", action: "super_secret_jump", pressed: true, strengthMillionths: 1_000_000 } },
    { operation: "sequence", handle, mode: "realtime", timeoutMs: 1_000, events: [{ frameOffset: 0, event: { type: "mouse_motion", position: { x: 1234, y: -5678 }, viewportPath: ".", coordinateSpace: "viewport" } }] },
    { operation: "record_stop", handle },
    { operation: "replay", handle, mode: "deterministic", timeoutMs: 1_000, trace: { schemaVersion: 1, events: [{ frameOffset: 0, event: { type: "key", keycode: 424242, pressed: true } }] } },
  ] as const;
  for (const argumentsValue of calls) {
    const result = await client.callTool({ name: "godot_input", arguments: argumentsValue });
    expect(result.structuredContent).toMatchObject({ ok: true, data: { receipt: { operation: argumentsValue.operation } } });
  }
  const audit = await readFile(auditPath, "utf8");
  const auditArguments = audit.trim().split("\n").map((line) => (JSON.parse(line) as { arguments: unknown }).arguments);
  const serializedArguments = JSON.stringify(auditArguments);
  expect(serializedArguments).not.toContain("super_secret_jump");
  expect(serializedArguments).not.toContain("424242");
  expect(serializedArguments).not.toContain("-5678");
  expect(auditArguments).toEqual(expect.arrayContaining([
    expect.objectContaining({ operation: "send", eventCount: 1, eventKinds: { action: 1 } }),
    expect.objectContaining({ operation: "sequence", eventCount: 1, eventKinds: { mouse_motion: 1 } }),
    expect.objectContaining({ operation: "replay", eventCount: 1, eventKinds: { key: 1 } }),
  ]));
  expect(audit).toContain('"eventKinds":{"action":1}');
  expect(audit).toContain('"eventKinds":{"mouse_motion":1}');
  expect(audit).toContain('"eventKinds":{"key":1}');
  expect(audit).toContain('"traceSha256"');
});
