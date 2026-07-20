import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it } from "vitest";

import { EvidenceStore, JsonlAuditSink, SessionService, type SessionGrants } from "@godot-mcp/control-plane";
import type { InputOperationInput, VisualOperationInput } from "@godot-mcp/protocol";

import { createGodotMcpServer } from "./createServer.js";

const cleanups: Array<() => Promise<void>> = [];
const handle = { runId: "019f644c-1379-79c0-825e-66a4b7653bd1", generation: 1 };
const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const observationUri = `godot-mcp://evidence/${"a".repeat(64)}/observations/019f644c-1379-79c0-825e-66a4b7653bd2`;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(grants: SessionGrants) {
  const directory = await mkdtemp(join(tmpdir(), "godot-mcp-visual-tools-"));
  cleanups.push(async () => rm(directory, { force: true, recursive: true }));
  const project = { projectId: handle.runId, rootRealPath: directory, projectConfigSha256: "a".repeat(64) };
  const auditPath = join(directory, "audit.jsonl");
  const session = new SessionService(project, grants, async () => ({ healthy: true, checks: [] }));
  session.onAttached({ sessionId: "session_12345678", godotVersion: "4.7.stable.official.test", addonVersion: "0.1.0", addonManifestSha256: "b".repeat(64), attachedAt: "2026-07-18T00:00:00.000Z" });
  const runtime = {
    launch: async () => ({ handle, root: {} }),
    execute: async () => ({}),
    capture: async () => ({ frames: [] }),
    input: async (input: InputOperationInput) => ({
      receipt: {
        handle: input.handle,
        operation: input.operation,
        eventCount: 0,
        deliveredCount: 0,
        deterministic: false,
        events: [],
        releases: [],
        traceSha256: "a".repeat(64),
        recording: input.operation === "record_start",
      },
    }),
  };
  const calls: VisualOperationInput[] = [];
  const visual = {
    async execute(input: VisualOperationInput) {
      calls.push(input);
      if (input.operation === "compare") {
        return {
          data: { passed: false, differentPixels: 1 },
          evidence: [observationUri],
          images: [{ data: png, mimeType: "image/png" as const }],
        };
      }
      if (input.operation === "scenario_start") return { data: { jobToken: `vsj_${"A".repeat(43)}`, state: "queued", completedSteps: 0, totalSteps: input.scenario.steps.length } };
      return { data: { operation: input.operation } };
    },
  };
  const server = createGodotMcpServer({
    project,
    grants,
    audit: new JsonlAuditSink(auditPath),
    session,
    bridge: () => null,
    evidence: new EvidenceStore(directory),
    runtime,
    visual,
  });
  const client = new Client({ name: "phase-8-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(async () => Promise.all([client.close(), server.close()]).then(() => undefined));
  return { auditPath, calls, client };
}

it.each([
  [{ tiers: ["observe"], packs: ["core"] }, 6],
  [{ tiers: ["observe", "runtime_control"], packs: ["core", "runtime", "input"] }, 9],
  [{ tiers: ["observe", "runtime_control"], packs: ["core", "visual"] }, 6],
  [{ tiers: ["observe", "runtime_control"], packs: ["core", "runtime", "visual"] }, 8],
  [{ tiers: ["observe", "runtime_control"], packs: ["core", "input", "visual"] }, 7],
  [{ tiers: ["observe", "runtime_control"], packs: ["core", "runtime", "input", "visual"] }, 10],
] as const)("registers visual only for complete grants %j", async (grants, expectedCount) => {
  const { client } = await fixture({ tiers: [...grants.tiers], packs: [...grants.packs] });
  const tools = (await client.listTools()).tools;
  const complete = ["runtime", "input", "visual"].every((pack) => (grants.packs as readonly string[]).includes(pack));
  expect(tools).toHaveLength(expectedCount);
  expect(tools.some((tool) => tool.name === "godot_visual")).toBe(complete);
});

it("forwards strict visual operations, returns diff images, and audits only summaries", async () => {
  const grants: SessionGrants = { tiers: ["observe", "runtime_control"], packs: ["core", "runtime", "input", "visual"] };
  const { auditPath, calls, client } = await fixture(grants);
  const compared = await client.callTool({ name: "godot_visual", arguments: {
    operation: "compare",
    name: "private-baseline",
    observationUri,
    settings: { maxChannelDelta: 0, maxDifferentPixels: 0, maxDifferentRatioMillionths: 0 },
  } });
  expect(compared.structuredContent).toMatchObject({ ok: true, data: { passed: false, differentPixels: 1 } });
  expect(compared.content).toEqual(expect.arrayContaining([{ type: "image", data: png.toString("base64"), mimeType: "image/png" }]));

  await client.callTool({ name: "godot_visual", arguments: {
    operation: "scenario_start",
    scenario: {
      name: "private-scenario",
      scenePath: "res://visual/visual_fixture.tscn",
      deadlineMs: 5_000,
      pins: { width: 320, height: 180, renderer: "gl_compatibility", locale: "en_NZ", seed: 42, fixedFps: 60 },
      steps: [
        { kind: "assert", assertion: { type: "property_equals", nodePath: ".", property: "mode", value: "do-not-audit-this" } },
        { kind: "input", trace: { schemaVersion: 1, events: [{ frameOffset: 0, event: { type: "action", action: "private-action", pressed: true } }] } },
      ],
    },
  } });

  expect(calls.map((call) => call.operation)).toEqual(["compare", "scenario_start"]);
  const audit = await readFile(auditPath, "utf8");
  const auditArguments = audit.trim().split("\n").map((line) => (JSON.parse(line) as { arguments: unknown }).arguments);
  const serializedArguments = JSON.stringify(auditArguments);
  expect(audit).not.toContain("private-baseline");
  expect(audit).not.toContain("private-scenario");
  expect(audit).not.toContain("do-not-audit-this");
  expect(audit).not.toContain("private-action");
  expect(serializedArguments).not.toContain(observationUri);
  expect(audit).not.toContain(png.toString("base64"));
  expect(audit).toContain(createHash("sha256").update("private-scenario").digest("hex"));
  expect(audit).toContain('"stepKinds":{"assert":1,"input":1}');
});
