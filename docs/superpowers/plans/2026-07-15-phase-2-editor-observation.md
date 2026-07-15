# Phase 2 Editor Observation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded, read-only editor inspection and real 2D/3D editor viewport images through the authenticated bridge, exposed as the `godot_query` and `godot_capture` MCP tools.

**Architecture:** The MCP server sends typed request/response commands through the existing authenticated `BridgeSession`. The addon verifies and queues commands on Godot's main thread, delegates them to focused observation and capture adapters, and returns bounded JSON or ordered PNG chunks without raising the Phase 1 one-MiB frame limit. The control plane persists captures in a content-addressed, session-scoped evidence store while the MCP adapter returns the image as real MCP image content.

**Tech Stack:** Node.js 22; pnpm 11.13.0; TypeScript 6.0.3; Zod 4.4.3; MCP TypeScript SDK 1.29.0; ws 8.21.0; Vitest 4.1.10; pngjs 7.0.0 for test-only PNG assertions; Godot 4.7 stable; GDScript.

## Global Constraints

- Inherit every security, attachment, identity, replay, deadline, audit, cleanup, and addon-installation invariant from Phase 0-1.
- Keep MCP on stdio and keep the authenticated bridge bound only to `127.0.0.1`; the addon opens no listener.
- Preserve the existing one-MiB WebSocket `maxPayload`; large captures use signed chunks no larger than 512 KiB of decoded PNG data.
- Phase 2 adds only `godot_query` and `godot_capture`; all six tools remain in the `core` capability pack and require only `observe`.
- Every Phase 2 command is read-only, repeat-safe, bounded, deadline-aware, and audited; it may not save scenes, alter selection, switch editor screens, trigger imports, or change project/editor settings.
- All SceneTree and editor-object reads run on Godot's main thread through a queue capped at 32 entries and one active command.
- Query output is capped at 1,000 nodes, 2,000 resources, 500 diagnostics, 128 properties per object, 32 levels of scene depth, and 512 KiB of serialized JSON.
- Captures are PNG only, at most 2,048 by 2,048 pixels, 8 MiB decoded, 16 chunks, and one capture in flight per session.
- Observation returns resource/script metadata but never source text, arbitrary file bytes, editor credentials, environment variables, secrets, or absolute host paths.
- Only already-open scene roots and EditorFileSystem-indexed `res://` resources may be inspected; Phase 2 does not load caller-supplied resource paths.
- Diagnostic capture uses a bounded in-memory logger and redacts secret-like values and host paths before data crosses the bridge.
- Tests that open an editor or render a viewport use disposable copies of `fixtures/godot-4.7`; do not mutate `/Users/tony/Projects/town-building-game`.
- The authoritative completion gate is `GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-2`; Phase 0-1's gate remains runnable and must continue to pass.
- Follow test-driven development: observe each focused test fail before implementing its production code.
- Commit after every task with only that task's files staged.

---

## Planned file map

```text
packages/protocol/src/editor.ts                    Phase 2 public and bridge schemas
packages/protocol/src/schemas.ts                   Shared response/error extensions
packages/protocol/src/index.ts                     Phase 2 exports

packages/bridge-client/src/bridgeSession.ts        Correlated request lifecycle and chunk assembly
packages/bridge-client/src/bridgeSession.test.ts   Timeout, disconnect, result, and chunk tests

packages/control-plane/src/policy/capabilities.ts  Query/capture policies and six-tool visibility
packages/control-plane/src/help/coreHelp.ts         Query/capture help topics
packages/control-plane/src/evidence/evidenceStore.ts Content-addressed PNG persistence
packages/control-plane/src/evidence/evidenceStore.test.ts Bounds and atomic persistence tests

packages/mcp-server/src/executeTool.ts              Shared authorization/audit execution wrapper
packages/mcp-server/src/registerCoreTools.ts        Existing four tools plus query and capture
packages/mcp-server/src/toolResult.ts               Text plus real MCP image result conversion
packages/mcp-server/src/registerCoreTools.test.ts   Six-tool schemas, policy, errors, and image content

addons/godot_mcp/bridge/bridge_client.gd            Receive commands and send result/chunk envelopes
addons/godot_mcp/commands/main_thread_queue.gd       Bounded single-flight main-thread dispatch
addons/godot_mcp/observation/variant_encoder.gd      Bounded JSON-safe Godot Variant encoding
addons/godot_mcp/observation/diagnostic_logger.gd    Thread-safe redacted diagnostic ring
addons/godot_mcp/observation/editor_query.gd         State/tree/node/resource/settings/diagnostic reads
addons/godot_mcp/observation/editor_capture.gd       2D/3D viewport PNG capture and chunking
addons/godot_mcp/plugin.gd                           Adapter lifecycle and queue wiring

fixtures/godot-4.7/observation/fixture_resource.tres Known resource metadata
fixtures/godot-4.7/observation/fixture_script.gd     Known script metadata, signals, groups, diagnostics
fixtures/godot-4.7/observation/editor_2d.tscn        Deterministic nonblank 2D editor fixture
fixtures/godot-4.7/observation/editor_3d.tscn        Deterministic nonblank 3D editor fixture

tests/integration/editor-observation.test.ts         Real editor query truth and zero-diff checks
tests/integration/editor-capture.test.ts             Real nonblank 2D/3D PNG checks
tests/security/editor-observation-hostile.test.ts    Bounds, stale/deadline, path, and redaction checks
tests/end-to-end/phase-2.test.ts                     Published stdio/editor six-tool acceptance
packages/testkit/src/e2e.ts                           Scene-aware visible editor and full content blocks

scripts/qa-phase-2.mjs                               Pinned Phase 2 acceptance gate
docs/protocol/bridge-v1.md                           Phase 2 request/result/chunk messages
docs/security/threat-model.md                        Observation and capture abuse analysis
docs/testing/phase-2.md                              Gate, deterministic rendering, and receipts
README.md                                            Phase 2 capability and limitation summary
```

## Public operation contract

`godot_query` accepts one of these exact operations:

| operation | Required fields | Result |
|---|---|---|
| `editor_state` | none | current scene, open/unsaved scenes, selected nodes/files, main-screen name when discoverable, filesystem/import state |
| `scene_tree` | optional `scenePath`, `maxDepth`, `maxNodes` | bounded preorder tree from an already-open scene |
| `node` | `scenePath`, `nodePath`, optional `includeProperties` | one open-scene node's identity, metadata, groups, signals, script metadata, and bounded properties |
| `resources` | optional `prefix`, `kinds`, `cursor`, `limit` | EditorFileSystem-indexed resource metadata; no resource loading or file contents |
| `project_settings` | required approved `prefix`, optional `cursor`, `limit` | bounded non-secret project-setting values from approved namespaces |
| `diagnostics` | optional `afterSequence`, `levels`, `limit` | redacted logger records captured after addon activation |

`godot_capture` accepts `{ viewport: "2d" | "3d", viewportIndex?: 0 | 1 | 2 | 3, maxWidth?: 1..2048, maxHeight?: 1..2048 }`. `viewportIndex` is forbidden for `2d`. The structured result contains metadata and an evidence URI; the MCP content array additionally contains `{ type: "image", data: <base64>, mimeType: "image/png" }`.

## Internal interfaces

The TypeScript bridge exposes:

```ts
export interface BridgeRequestOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  correlationId?: string;
}

export interface BridgeCommandResult<T> {
  requestId: string;
  data: T;
  binary?: Uint8Array;
  binarySha256?: string;
}

request<T>(method: "editor.query" | "editor.capture", params: unknown, options?: BridgeRequestOptions): Promise<BridgeCommandResult<T>>;
```

Addon responses use signed envelopes:

```json
{ "method": "command.chunk", "params": { "requestId": "...", "index": 0, "total": 2, "sha256": "...", "data": "<base64url>" } }
{ "method": "command.result", "params": { "requestId": "...", "ok": true, "data": {}, "binary": { "size": 700000, "sha256": "...", "chunks": 2 } } }
{ "method": "command.result", "params": { "requestId": "...", "ok": false, "error": { "code": "TARGET_NOT_FOUND", "message": "...", "retryable": false } } }
```

Chunks may arrive only before their matching terminal result, must be contiguous from zero, must agree on `total` and `sha256`, and are discarded on timeout, disconnect, protocol error, or cancellation.

---

### Task 1: Define Phase 2 protocol, policies, and help

**Files:**
- Create: `packages/protocol/src/editor.ts`
- Create: `packages/protocol/src/editor.test.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/control-plane/src/policy/capabilities.ts`
- Modify: `packages/control-plane/src/policy/authorize.test.ts`
- Modify: `packages/control-plane/src/help/coreHelp.ts`
- Modify: `packages/control-plane/src/session/sessionService.test.ts`

**Interfaces:**
- Produces `EditorQueryInputSchema`, `EditorCaptureInputSchema`, `BridgeCommandResultSchema`, `BridgeCommandChunkSchema`, and inferred TypeScript types.
- Produces `CORE_QUERY_POLICY` and `CORE_CAPTURE_POLICY`, both `{ tier: "observe", pack: "core", mutating: false }`.
- Changes visible core operations from four to six without changing permission expansion.

- [ ] **Step 1: Write failing schema and capability tests**

```ts
// packages/protocol/src/editor.test.ts
import { describe, expect, it } from "vitest";
import { EditorCaptureInputSchema, EditorQueryInputSchema } from "./editor.js";

describe("Phase 2 editor schemas", () => {
  it("accepts the six bounded query variants", () => {
    expect(EditorQueryInputSchema.parse({ operation: "editor_state" })).toEqual({ operation: "editor_state" });
    expect(EditorQueryInputSchema.parse({ operation: "scene_tree", maxDepth: 32, maxNodes: 1000 }).operation).toBe("scene_tree");
    expect(EditorQueryInputSchema.parse({ operation: "node", scenePath: "res://observation/editor_2d.tscn", nodePath: "Canvas/Label" }).operation).toBe("node");
    expect(EditorQueryInputSchema.parse({ operation: "resources", prefix: "res://observation", limit: 2000 }).operation).toBe("resources");
    expect(EditorQueryInputSchema.parse({ operation: "project_settings", prefix: "rendering/", limit: 200 }).operation).toBe("project_settings");
    expect(EditorQueryInputSchema.parse({ operation: "diagnostics", levels: ["warning", "error"], limit: 500 }).operation).toBe("diagnostics");
  });

  it("rejects paths, bounds, and capture combinations outside Phase 2", () => {
    expect(() => EditorQueryInputSchema.parse({ operation: "node", scenePath: "/tmp/x.tscn", nodePath: "." })).toThrow();
    expect(() => EditorQueryInputSchema.parse({ operation: "scene_tree", maxNodes: 1001 })).toThrow();
    expect(() => EditorCaptureInputSchema.parse({ viewport: "2d", viewportIndex: 1 })).toThrow();
    expect(() => EditorCaptureInputSchema.parse({ viewport: "3d", viewportIndex: 4 })).toThrow();
    expect(() => EditorCaptureInputSchema.parse({ viewport: "2d", maxWidth: 2049 })).toThrow();
  });
});
```

Extend the existing policy test with:

```ts
expect(visibleCapabilities({ tiers: ["observe"], packs: ["core"] }).map((item) => item.command).sort()).toEqual([
  "godot_capabilities", "godot_capture", "godot_doctor", "godot_help", "godot_query", "godot_session",
]);
```

- [ ] **Step 2: Run the focused tests and verify the missing exports fail**

Run:

```bash
pnpm exec vitest run packages/protocol/src/editor.test.ts packages/control-plane/src/policy/authorize.test.ts packages/control-plane/src/session/sessionService.test.ts
```

Expected: FAIL because `editor.ts`, `CORE_QUERY_POLICY`, and `CORE_CAPTURE_POLICY` do not exist and capability discovery still returns four tools.

- [ ] **Step 3: Add exact schemas and exports**

```ts
// packages/protocol/src/editor.ts
import { z } from "zod";

const ResPathSchema = z.string().regex(/^res:\/\/(?!.*(?:^|\/)\.\.?(?:\/|$))[^\0]*$/).max(512);
const NodePathSchema = z.string().min(1).max(512).refine((value) => !value.split("/").includes(".."));
const PageSchema = { cursor: z.string().max(256).optional(), limit: z.number().int().min(1).max(2000).default(200) };

export const EditorQueryInputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("editor_state") }).strict(),
  z.object({ operation: z.literal("scene_tree"), scenePath: ResPathSchema.optional(), maxDepth: z.number().int().min(0).max(32).default(12), maxNodes: z.number().int().min(1).max(1000).default(500) }).strict(),
  z.object({ operation: z.literal("node"), scenePath: ResPathSchema, nodePath: NodePathSchema, includeProperties: z.boolean().default(true) }).strict(),
  z.object({ operation: z.literal("resources"), prefix: ResPathSchema.default("res://"), kinds: z.array(z.enum(["scene", "script", "resource", "shader", "texture", "audio", "other"])).max(7).optional(), ...PageSchema }).strict(),
  z.object({ operation: z.literal("project_settings"), prefix: z.enum(["application/", "audio/", "display/", "input/", "navigation/", "physics/", "rendering/"]), ...PageSchema }).strict(),
  z.object({ operation: z.literal("diagnostics"), afterSequence: z.number().int().min(0).default(0), levels: z.array(z.enum(["log", "warning", "error", "script", "shader"])).min(1).max(5).default(["log", "warning", "error", "script", "shader"]), limit: z.number().int().min(1).max(500).default(100) }).strict(),
]);

export const EditorCaptureInputSchema = z.object({
  viewport: z.enum(["2d", "3d"]),
  viewportIndex: z.number().int().min(0).max(3).optional(),
  maxWidth: z.number().int().min(1).max(2048).default(1280),
  maxHeight: z.number().int().min(1).max(2048).default(720),
}).strict().superRefine((value, context) => {
  if (value.viewport === "2d" && value.viewportIndex !== undefined) context.addIssue({ code: "custom", path: ["viewportIndex"], message: "viewportIndex is valid only for 3d" });
});

export const BridgeCommandChunkSchema = z.object({
  requestId: z.uuid(), index: z.number().int().min(0).max(15), total: z.number().int().min(1).max(16),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), data: z.string().max(700_000),
}).strict();

export const BridgeCommandResultSchema = z.object({
  requestId: z.uuid(), ok: z.boolean(), data: z.unknown().optional(),
  binary: z.object({ size: z.number().int().min(1).max(8 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/), chunks: z.number().int().min(1).max(16) }).strict().optional(),
  error: z.object({ code: z.enum(["INVALID_REQUEST", "PAYLOAD_TOO_LARGE", "TARGET_NOT_FOUND", "TIMEOUT", "GODOT_RUNTIME_ERROR"]), message: z.string().max(4096), retryable: z.boolean() }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.ok === (value.error !== undefined)) context.addIssue({ code: "custom", message: "success requires data/no error; failure requires error" });
});

export type EditorQueryInput = z.infer<typeof EditorQueryInputSchema>;
export type EditorCaptureInput = z.infer<typeof EditorCaptureInputSchema>;
export type BridgeCommandChunk = z.infer<typeof BridgeCommandChunkSchema>;
export type BridgeCommandResult = z.infer<typeof BridgeCommandResultSchema>;
```

Export the file from `packages/protocol/src/index.ts` with `export * from "./editor.js";`.

- [ ] **Step 4: Add query/capture policies and focused help**

In `capabilities.ts`, add:

```ts
export const CORE_QUERY_POLICY: CommandPolicy = { command: "godot_query", tier: "observe", pack: "core", mutating: false };
export const CORE_CAPTURE_POLICY: CommandPolicy = { command: "godot_capture", tier: "observe", pack: "core", mutating: false };

export const CORE_POLICIES: readonly CommandPolicy[] = [
  CORE_CAPABILITIES_POLICY, CORE_CAPTURE_POLICY, CORE_DOCTOR_POLICY,
  CORE_HELP_POLICY, CORE_QUERY_POLICY, CORE_SESSION_POLICY,
];
```

Replace `PHASE_ONE_POLICIES` use inside `visibleCapabilities` with `CORE_POLICIES`. Keep `PHASE_ONE_POLICIES` exported as the original four-item list for Phase 0-1 regression tests.

Extend `CoreHelpTopic` with `"query" | "capture"`, add help records whose summaries enumerate the exact operations and bounds from the public contract, and change the unknown-topic message from `Unknown Phase 1 help topic` to `Unknown core help topic`.

- [ ] **Step 5: Run checks and commit**

Run:

```bash
pnpm exec vitest run packages/protocol/src/editor.test.ts packages/control-plane/src/policy/authorize.test.ts packages/control-plane/src/session/sessionService.test.ts
pnpm typecheck
```

Expected: PASS.

```bash
git add packages/protocol/src/editor.ts packages/protocol/src/editor.test.ts packages/protocol/src/index.ts packages/control-plane/src/policy/capabilities.ts packages/control-plane/src/policy/authorize.test.ts packages/control-plane/src/help/coreHelp.ts packages/control-plane/src/session/sessionService.test.ts
git commit -m "feat: define editor observation contracts"
```

### Task 2: Add correlated bridge requests and bounded chunk assembly

**Files:**
- Modify: `packages/bridge-client/src/bridgeSession.ts`
- Create: `packages/bridge-client/src/bridgeSession.test.ts`
- Modify: `packages/bridge-client/src/index.ts`
- Modify: `packages/bridge-client/src/bridgeServer.ts`

**Interfaces:**
- Consumes signed `command.result` and `command.chunk` envelopes.
- Produces `BridgeSession.request<T>()` with timeout/disconnect cleanup and verified optional binary bytes.
- Preserves `send()` for pairing and existing tests.

- [ ] **Step 1: Write failing request lifecycle tests**

Use an in-memory paired WebSocket fixture extracted from `bridgeServer.test.ts`, then add these assertions:

```ts
it("correlates a command result without exposing unrelated envelopes", async () => {
  const request = session.request<{ state: string }>("editor.query", { operation: "editor_state" }, { timeoutMs: 1000 });
  const sent = await client.nextSignedEnvelope();
  client.sendSigned("command.result", { requestId: sent.params.requestId, ok: true, data: { state: "ready" } });
  await expect(request).resolves.toMatchObject({ data: { state: "ready" } });
});

it("assembles contiguous chunks and verifies size and sha256", async () => {
  const png = Buffer.concat([Buffer.from("chunk-a"), Buffer.from("chunk-b")]);
  const sha256 = createHash("sha256").update(png).digest("hex");
  const request = session.request("editor.capture", { viewport: "2d" }, { timeoutMs: 1000, maxResponseBytes: 1024 });
  const sent = await client.nextSignedEnvelope();
  const requestId = String((sent.params as { requestId: string }).requestId);
  client.sendSigned("command.chunk", { requestId, index: 0, total: 2, sha256, data: Buffer.from("chunk-a").toString("base64url") });
  client.sendSigned("command.chunk", { requestId, index: 1, total: 2, sha256, data: Buffer.from("chunk-b").toString("base64url") });
  client.sendSigned("command.result", { requestId, ok: true, data: { mimeType: "image/png" }, binary: { size: png.length, sha256, chunks: 2 } });
  await expect(request).resolves.toMatchObject({ binarySha256: sha256, binary: new Uint8Array(png) });
});

it.each(["duplicate", "out-of-order", "digest", "oversize"])("rejects invalid %s chunk streams", async (caseName) => {
  await expect(runInvalidChunkCase(caseName)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
});

it("rejects pending requests on timeout and disconnect", async () => {
  await expect(session.request("editor.query", {}, { timeoutMs: 5 })).rejects.toMatchObject({ code: "TIMEOUT" });
  const pending = session.request("editor.query", {}, { timeoutMs: 1000 });
  client.close();
  await expect(pending).rejects.toMatchObject({ code: "NOT_ATTACHED" });
});
```

- [ ] **Step 2: Run the focused test and verify `request` is missing**

Run: `pnpm exec vitest run packages/bridge-client/src/bridgeSession.test.ts`

Expected: FAIL because `BridgeSession.request` and command message parsing do not exist.

- [ ] **Step 3: Implement pending requests and chunk state**

Add these private types and limits to `bridgeSession.ts`:

```ts
const MAX_PENDING_REQUESTS = 16;
const MAX_CHUNK_BYTES = 512 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;

interface PendingRequest {
  resolve(value: BridgeCommandResult<unknown>): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
  maxResponseBytes: number;
  chunks: Uint8Array[];
  nextChunkIndex: number;
  totalChunks?: number;
  binarySha256?: string;
  receivedBytes: number;
}
```

Add a `Map<string, PendingRequest>`, reject all entries in the socket close handler, and implement:

```ts
request<T>(method: "editor.query" | "editor.capture", params: unknown, options: BridgeRequestOptions = {}): Promise<BridgeCommandResult<T>> {
  if (this.pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(commandError("CONFLICT", "Bridge request queue is full"));
  const requestId = options.correlationId ?? randomUUID();
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 30_000, 1), 30_000);
  const maxResponseBytes = Math.min(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, 8 * 1024 * 1024);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      this.pending.delete(requestId);
      reject(commandError("TIMEOUT", `Bridge request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    this.pending.set(requestId, { resolve: resolve as PendingRequest["resolve"], reject, timeout, maxResponseBytes, chunks: [], nextChunkIndex: 0, receivedBytes: 0 });
    try {
      this.send(method, { requestId, arguments: params }, Date.now() + timeoutMs);
    } catch (error) {
      clearTimeout(timeout);
      this.pending.delete(requestId);
      reject(error);
    }
  });
}
```

Route verified envelopes with method `command.chunk` and `command.result` into private handlers before emitting ordinary envelopes. Decode each chunk with `Buffer.from(data, "base64url")`; require exact next index, stable total/digest, at most 512 KiB per chunk, and cumulative bytes within the pending request limit. On terminal success, require chunk metadata to match, concatenate, verify size and SHA-256, clear the timeout/map entry, and resolve. On terminal error, translate the stable error into `GodotMcpException`. Any malformed command response rejects only the matching pending request with `INVALID_REQUEST` and closes the session when a trustworthy `requestId` cannot be obtained.

- [ ] **Step 4: Preserve transport and close invariants**

Keep `maxPayload: 1_048_576` unchanged in `bridgeServer.ts`. Add a bridge-server regression assertion that a post-pair frame over one MiB still closes with WebSocket code `1009`. Export `BridgeRequestOptions` and `BridgeCommandResult<T>` from `index.ts`.

- [ ] **Step 5: Run checks and commit**

Run:

```bash
pnpm exec vitest run packages/bridge-client/src/bridgeSession.test.ts packages/bridge-client/src/bridgeServer.test.ts
pnpm typecheck
```

Expected: PASS, including timeout/disconnect cleanup and the original one-MiB rejection.

```bash
git add packages/bridge-client/src/bridgeSession.ts packages/bridge-client/src/bridgeSession.test.ts packages/bridge-client/src/bridgeServer.ts packages/bridge-client/src/index.ts
git commit -m "feat: add bounded bridge command requests"
```

### Task 3: Add the addon main-thread queue and structured editor queries

**Files:**
- Create: `addons/godot_mcp/commands/main_thread_queue.gd`
- Create: `addons/godot_mcp/observation/variant_encoder.gd`
- Create: `addons/godot_mcp/observation/diagnostic_logger.gd`
- Create: `addons/godot_mcp/observation/editor_query.gd`
- Modify: `addons/godot_mcp/bridge/bridge_client.gd`
- Modify: `addons/godot_mcp/plugin.gd`
- Create: `fixtures/godot-4.7/tests/editor_observation_unit.gd`

**Interfaces:**
- Consumes authenticated `editor.query` commands shaped as `{ requestId, arguments }`.
- Produces `command.result` success/error envelopes.
- Produces bounded, JSON-safe query results and redacted diagnostics without loading resources.

- [ ] **Step 1: Write a failing headless GDScript unit harness**

Create `editor_observation_unit.gd` to instantiate `VariantEncoder`, encode nested values, fill a queue past 32 entries, feed the diagnostic logger secret/absolute-path text, and assert:

```gdscript
extends SceneTree

const VariantEncoder = preload("res://addons/godot_mcp/observation/variant_encoder.gd")
const DiagnosticLogger = preload("res://addons/godot_mcp/observation/diagnostic_logger.gd")
const MainThreadQueue = preload("res://addons/godot_mcp/commands/main_thread_queue.gd")

func _init() -> void:
	var encoded := VariantEncoder.encode_value(Vector2(3, 4), 0)
	assert(encoded == {"type": "Vector2", "x": 3.0, "y": 4.0})
	assert(VariantEncoder.encode_value(preload("res://main.gd"), 0).path == "res://main.gd")
	var logger := DiagnosticLogger.new("/Users/example/secret-project")
	logger.record_for_test("error", "token=abc123 at /Users/example/secret-project/main.gd")
	var records: Array = logger.read_after(0, ["error"], 10)
	assert("abc123" not in JSON.stringify(records))
	assert("/Users/example" not in JSON.stringify(records))
	var queue := MainThreadQueue.new()
	for index in 33:
		var accepted: bool = queue.enqueue({"requestId": str(index), "deadlineUnixMs": 9999999999999, "method": "editor.query", "arguments": {}})
		assert(accepted == (index < 32))
	print("GODOT_MCP_EDITOR_OBSERVATION_UNIT_OK")
	quit(0)
```

- [ ] **Step 2: Install the current addon into a disposable fixture and verify the harness fails**

Run:

```bash
tmp="$(mktemp -d)"
cp -R fixtures/godot-4.7 "$tmp/project"
node packages/cli/dist/bin.js init --project "$tmp/project"
GODOT_BIN=/opt/homebrew/bin/godot /opt/homebrew/bin/godot --headless --path "$tmp/project" --script res://tests/editor_observation_unit.gd
rm -rf "$tmp"
```

Expected: FAIL because the Phase 2 addon scripts do not exist.

- [ ] **Step 3: Implement the bounded queue**

`MainThreadQueue` extends `Node`, stores at most 32 dictionaries, rejects expired commands before execution, runs only one deferred command at a time, and emits `completed(request_id, result)` or `failed(request_id, code, message, retryable)`. Its `enqueue()` returns false when full. Its `_run_next()` awaits the injected handler callable and schedules the next item with `call_deferred`, ensuring editor objects are accessed only from the main thread.

Use this command dictionary throughout:

```gdscript
{
	"requestId": String,
	"deadlineUnixMs": int,
	"method": String,
	"arguments": Dictionary,
}
```

Reject deadlines earlier than `int(Time.get_unix_time_from_system() * 1000.0)` with `TIMEOUT`, missing handlers with `INVALID_REQUEST`, and handler failures with the handler's stable code. Clear pending commands during plugin exit and emit no responses after the bridge closes.

- [ ] **Step 4: Implement JSON-safe encoding and diagnostic capture**

`VariantEncoder.encode_value(value, depth)` must:

- Return JSON primitives unchanged, except truncate strings at 4,096 UTF-8 bytes.
- Encode `StringName` and `NodePath` as strings.
- Encode vectors, rects, transforms, colors, and AABBs as `{ type, ...components }` dictionaries.
- Encode `Resource` as `{ type, className, path, uid }` only; never serialize resource properties or source.
- Encode `Node` as `{ type: "NodeRef", className, nodePath }` only.
- Encode arrays/dictionaries to depth four and 128 entries, then return `{ truncated: true }`.
- Return `{ type: typeof(value), unsupported: true }` for callable, RID, object, packed binary, and unknown values.
- Replace absolute paths with `[redacted-path]` and redact values adjacent to case-insensitive `token`, `secret`, `password`, `authorization`, `cookie`, and `api_key` keys.

`DiagnosticLogger` extends `Logger`, registers with `OS.add_logger()` in `plugin.gd`, and stores at most 500 records with monotonic `sequence`, ISO timestamp, level, message, source, line, and function. Protect callback writes with `Mutex`; `_log_error` maps Godot error types to `error`, `warning`, `script`, or `shader`; `_log_message` maps to `log` or `error`. Clip each record to 4,096 bytes and redact before insertion. `read_after()` copies matching records while holding the mutex, then releases it before encoding. Remove the logger with `OS.remove_logger()` on plugin exit.

- [ ] **Step 5: Implement exact query variants**

`EditorQuery` receives `EditorInterface` and `DiagnosticLogger` and exposes `execute(arguments: Dictionary) -> Dictionary`. Implement:

- `editor_state`: `get_edited_scene_root()`, `get_open_scenes()`, `get_unsaved_scenes()`, `get_selected_paths()`, `get_selection().get_selected_nodes()`, `get_resource_filesystem().is_scanning()`, `is_importing()`, and `get_scanning_progress()`. Return paths as `res://` only.
- `scene_tree`: find the requested path only among zipped `get_open_scenes()` and `get_open_scene_roots()`, or use the edited root when omitted; traverse preorder; return `nodePath`, `name`, `className`, `ownerPath`, `childCount`, `groups`, and script metadata. Stop exactly at requested depth/count and set `truncated`.
- `node`: resolve only within the matching open scene using `root.get_node_or_null(NodePath(nodePath))`; return identity, owner, groups, `get_signal_list()`, connections whose source/target are in the same open scene, script metadata, and at most 128 storage/editor properties encoded by `VariantEncoder` when `includeProperties` is true.
- `resources`: recurse only through `EditorFileSystem.get_filesystem()` using `EditorFileSystemDirectory` getters; collect path, type, UID, import validity, and script/resource kind; sort by path before cursor/limit paging. Never call `load`, `ResourceLoader.load`, `FileAccess`, or `DirAccess`.
- `project_settings`: enumerate `ProjectSettings.get_property_list()`, filter the approved prefix, reject secret-like names, encode values, sort by name, and page. Return `name`, `type`, `value`, and `changedFromDefault`.
- `diagnostics`: call the logger's bounded `read_after`.

Every result includes `{ operation, truncated, nextCursor }` as applicable. Before returning, reject JSON larger than 512 KiB with `PAYLOAD_TOO_LARGE` rather than slicing invalid JSON.

- [ ] **Step 6: Wire commands through the bridge and plugin**

Add `signal command_received(command: Dictionary)` to `bridge_client.gd`. After envelope verification and pairing completion, accept only `editor.query` and `editor.capture`; validate `params.requestId` and `params.arguments`, then emit a dictionary containing the envelope deadline. Add public `send_command_result`, `send_command_error`, and `send_command_chunk` methods that call `_send_signed` and refuse calls while unpaired.

In `plugin.gd`, construct the logger, query adapter, queue, and later capture adapter; connect bridge commands to `queue.enqueue`; connect queue completion/failure to the bridge send methods. Remove logger, disconnect signals, clear/free queue and adapters, then close/free the bridge in `_exit_tree()`.

- [ ] **Step 7: Run the GDScript harness, TypeScript regression tests, and commit**

Run the disposable harness command from Step 2 again.

Expected: `GODOT_MCP_EDITOR_OBSERVATION_UNIT_OK` and exit 0.

Run: `pnpm exec vitest run packages/bridge-client packages/protocol`

Expected: PASS.

```bash
git add addons/godot_mcp/commands addons/godot_mcp/observation addons/godot_mcp/bridge/bridge_client.gd addons/godot_mcp/plugin.gd fixtures/godot-4.7/tests/editor_observation_unit.gd
git commit -m "feat: query Godot editor state safely"
```

### Task 4: Capture editor viewports and persist bounded evidence

**Files:**
- Create: `addons/godot_mcp/observation/editor_capture.gd`
- Modify: `addons/godot_mcp/plugin.gd`
- Create: `packages/control-plane/src/evidence/evidenceStore.ts`
- Create: `packages/control-plane/src/evidence/evidenceStore.test.ts`
- Modify: `packages/control-plane/src/index.ts`
- Modify: `packages/protocol/src/schemas.ts`

**Interfaces:**
- Produces PNG metadata plus ordered signed chunks from the addon.
- Produces `EvidenceStore.putPng(sessionId, png, metadata)` returning a content-addressed `godot-mcp://evidence/<sha256>` reference.
- Extends audit inputs/records with evidence references without breaking existing records.

- [ ] **Step 1: Write failing evidence-store tests**

```ts
// packages/control-plane/src/evidence/evidenceStore.test.ts
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { copyFixture } from "@godot-mcp/testkit";
import { describe, expect, it } from "vitest";
import { EvidenceStore } from "./evidenceStore.js";

const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("EvidenceStore", () => {
  it("writes content-addressed owner-only PNG evidence atomically", async () => {
    const project = await copyFixture();
    try {
      const store = new EvidenceStore(project.root);
      const first = await store.putPng("session_test", png, { viewport: "2d", width: 1, height: 1 });
      const second = await store.putPng("session_test", png, { viewport: "2d", width: 1, height: 1 });
      expect(second).toEqual(first);
      expect(first.uri).toBe(`godot-mcp://evidence/${first.sha256}`);
      expect(await readFile(first.path)).toEqual(png);
      expect((await stat(first.path)).mode & 0o077).toBe(0);
    } finally { await project.cleanup(); }
  });

  it("rejects non-PNG, oversized, and invalid session input", async () => {
    const project = await copyFixture();
    try {
      const store = new EvidenceStore(project.root);
      await expect(store.putPng("../escape", png, { viewport: "2d", width: 1, height: 1 })).rejects.toMatchObject({ code: "PATH_DENIED" });
      await expect(store.putPng("session_test", Buffer.alloc(8 * 1024 * 1024 + 1), { viewport: "2d", width: 1, height: 1 })).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
      await expect(store.putPng("session_test", Buffer.from("not-png"), { viewport: "2d", width: 1, height: 1 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    } finally { await project.cleanup(); }
  });
});
```

- [ ] **Step 2: Run the test and verify the store is missing**

Run: `pnpm exec vitest run packages/control-plane/src/evidence/evidenceStore.test.ts`

Expected: FAIL because `EvidenceStore` does not exist.

- [ ] **Step 3: Implement viewport capture and chunk sending**

`EditorCapture.execute(arguments)` must:

1. Resolve `get_editor_viewport_2d()` or `get_editor_viewport_3d(index)` without switching screens.
2. Await `RenderingServer.frame_post_draw`, then call `viewport.get_texture().get_image()`.
3. Reject null/empty images with `TARGET_NOT_FOUND`.
4. Preserve aspect ratio while shrinking only, using `Image.INTERPOLATE_LANCZOS`, to fit max width/height.
5. Encode with `save_png_to_buffer()`, reject empty or over 8 MiB.
6. Compute SHA-256 with `HashingContext`.
7. Split the PNG into slices of at most 512 KiB, base64url-encode each slice, and return metadata containing width, height, viewport, viewportIndex, byteLength, sha256, and chunks.

The plugin sends all chunks in increasing index before the terminal result. If the bridge closes or deadline expires between chunks, stop immediately and retain no bytes. Do not write capture bytes from GDScript.

- [ ] **Step 4: Implement atomic, content-addressed evidence**

`EvidenceStore` writes under `<project>/.godot/evidence/godot-mcp/sessions/<safe-session-id>/`. Validate session IDs with `/^session_[A-Za-z0-9_-]{8,128}$/`, verify PNG signature and 8 MiB limit, compute SHA-256, write `<sha>.png.tmp-<uuid>` with mode `0o600`, rename to `<sha>.png`, and write `<sha>.json` metadata the same way. If the target already exists, verify its digest before reusing it. Return:

```ts
export interface EvidenceReference {
  uri: `godot-mcp://evidence/${string}`;
  sha256: string;
  mimeType: "image/png";
  byteLength: number;
  path: string; // internal only; never include this in MCP data or audit arguments
}
```

Extend `AuditRecordSchema` with `evidence: z.array(z.string()).default([])` and `AuditInput` with optional `evidence`; existing call sites omit it and serialize `[]`. Never put `EvidenceReference.path` into an audit record.

- [ ] **Step 5: Run checks and commit**

Run:

```bash
pnpm exec vitest run packages/control-plane/src/evidence/evidenceStore.test.ts packages/control-plane/src/audit/jsonlAuditSink.test.ts
pnpm typecheck
```

Expected: PASS.

```bash
git add addons/godot_mcp/observation/editor_capture.gd addons/godot_mcp/plugin.gd packages/control-plane/src/evidence packages/control-plane/src/index.ts packages/control-plane/src/audit/jsonlAuditSink.ts packages/control-plane/src/audit/jsonlAuditSink.test.ts packages/protocol/src/schemas.ts
git commit -m "feat: capture bounded editor viewport evidence"
```

### Task 5: Expose `godot_query` and real MCP image content

**Files:**
- Create: `packages/mcp-server/src/executeTool.ts`
- Modify: `packages/mcp-server/src/registerCoreTools.ts`
- Modify: `packages/mcp-server/src/registerCoreTools.test.ts`
- Modify: `packages/mcp-server/src/toolResult.ts`
- Modify: `packages/mcp-server/src/createServer.ts`
- Modify: `packages/cli/src/runtime/createRuntime.ts`
- Modify: `packages/cli/src/runtime/createRuntime.test.ts`

**Interfaces:**
- Consumes attached `BridgeSession`, `EvidenceStore`, query/capture schemas, and policies.
- Produces six MCP tools.
- Produces capture content containing both structured JSON text and a real MCP `image` block.

- [ ] **Step 1: Write failing six-tool and image tests**

Extend `registerCoreTools.test.ts` with an attached fake bridge and evidence store:

```ts
expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
  "godot_capabilities", "godot_capture", "godot_doctor", "godot_help", "godot_query", "godot_session",
]);

const query = await client.callTool({ name: "godot_query", arguments: { operation: "editor_state" } });
expect(query.structuredContent).toMatchObject({ ok: true, data: { operation: "editor_state" } });

const capture = await client.callTool({ name: "godot_capture", arguments: { viewport: "2d", maxWidth: 640, maxHeight: 480 } });
expect(capture.content).toEqual(expect.arrayContaining([
  expect.objectContaining({ type: "text" }),
  { type: "image", data: png.toString("base64"), mimeType: "image/png" },
]));
expect(capture.structuredContent).toMatchObject({ ok: true, data: { mimeType: "image/png", evidenceUri: expect.stringMatching(/^godot-mcp:\/\/evidence\//) } });
expect(JSON.stringify(capture.structuredContent)).not.toContain(png.toString("base64"));
```

Also assert unattached calls return `NOT_ATTACHED`, invalid inputs fail before bridge dispatch, bridge timeouts return `TIMEOUT`, and every call appends one audit record with no image bytes or internal evidence path.

- [ ] **Step 2: Run the focused test and verify only four tools exist**

Run: `pnpm exec vitest run packages/mcp-server/src/registerCoreTools.test.ts packages/cli/src/runtime/createRuntime.test.ts`

Expected: FAIL because query/capture are not registered and runtime does not inject bridge/evidence dependencies.

- [ ] **Step 3: Extract the shared execution wrapper**

Move `normalizeError` and `executeTool` from `registerCoreTools.ts` into `executeTool.ts`. Change the handler return to:

```ts
export interface ExecutedPayload<T = unknown> {
  data: T;
  evidence?: string[];
  image?: { data: Uint8Array; mimeType: "image/png" };
}

export interface ExecutedToolResult {
  result: ToolResult;
  image?: ExecutedPayload["image"];
}
```

Authorize before the handler, use one correlation ID from MCP through bridge and audit, append only public evidence URIs, and preserve all current error normalization. Existing four handlers return `{ data: ... }`.

- [ ] **Step 4: Register the exact tools**

Add `bridge: () => BridgeSession | null` and `evidence: EvidenceStore` to server dependencies. Register:

```ts
server.registerTool("godot_query", {
  title: "Query Godot editor",
  description: "Read bounded editor state, open scene metadata, indexed resources, approved project settings, or redacted diagnostics.",
  inputSchema: EditorQueryInputSchema,
  outputSchema: ToolResultSchema,
  annotations,
}, async (input) => {
  const executed = await executeTool(dependencies, CORE_QUERY_POLICY, input, async (correlationId) => {
    const bridge = requireAttachedBridge(dependencies.bridge());
    const response = await bridge.request("editor.query", input, { timeoutMs: 10_000, maxResponseBytes: 512 * 1024, correlationId });
    return { data: response.data };
  });
  return toMcpToolResult(executed);
});
```

Register `godot_capture` similarly with 15-second timeout and 8-MiB response limit. Verify response metadata using a Zod schema, require `binary`, persist it using the attachment's session ID, and return public metadata plus `evidenceUri`; pass the bytes only via the internal `image` field.

Update `toMcpToolResult` to base64-encode the image and append an MCP `ImageContent` block after the text block. `structuredContent` remains the `ToolResult` only.

- [ ] **Step 5: Inject live bridge and evidence dependencies**

In `createRuntime.ts`, construct `EvidenceStore(project.rootRealPath)`. Pass `bridge: () => bridge?.session ?? null` rather than a captured session so disconnects are observed immediately. Do not expose the evidence store's filesystem path through `SessionService` or MCP.

- [ ] **Step 6: Run checks and commit**

Run:

```bash
pnpm exec vitest run packages/mcp-server/src/registerCoreTools.test.ts packages/cli/src/runtime/createRuntime.test.ts
pnpm lint
pnpm typecheck
```

Expected: PASS with six tools, a real image content block, and no base64 in structured output/audit.

```bash
git add packages/mcp-server/src packages/cli/src/runtime/createRuntime.ts packages/cli/src/runtime/createRuntime.test.ts
git commit -m "feat: expose editor query and capture tools"
```

### Task 6: Build deterministic observation fixtures and real-editor acceptance

**Files:**
- Create: `fixtures/godot-4.7/observation/fixture_resource.tres`
- Create: `fixtures/godot-4.7/observation/fixture_script.gd`
- Create: `fixtures/godot-4.7/observation/editor_2d.tscn`
- Create: `fixtures/godot-4.7/observation/editor_3d.tscn`
- Modify: `packages/testkit/package.json`
- Modify: `packages/testkit/src/e2e.ts`
- Create: `tests/integration/editor-observation.test.ts`
- Create: `tests/integration/editor-capture.test.ts`
- Create: `tests/security/editor-observation-hostile.test.ts`
- Create: `tests/end-to-end/phase-2.test.ts`

**Interfaces:**
- Produces stable 2D/3D fixture truth and nonblank PNGs.
- Produces testkit support for opening a selected scene in a visible macOS editor and returning all MCP content blocks.
- Certifies zero project diff after observation and capture.

- [ ] **Step 1: Add fixture truth and test-only PNG decoder**

Create a 2D scene rooted at `Node2D` with a blue `ColorRect`, a `Label` containing `phase-2-2d`, a scripted child in groups `observable` and `ui`, a declared signal `fixture_event(value: int)`, and the `.tres` resource assigned to an exported property. Create a 3D scene rooted at `Node3D` with `WorldEnvironment`, `Camera3D`, `DirectionalLight3D`, and a red `MeshInstance3D` cube in front of the editor camera. Pin viewport background colors and avoid external assets/fonts.

Add `pngjs@7.0.0` and `@types/pngjs@6.0.5` to `packages/testkit` dev dependencies. Add:

```ts
export function inspectPng(data: Uint8Array): { width: number; height: number; uniqueColors: number } {
  const decoded = PNG.sync.read(Buffer.from(data));
  const colors = new Set<string>();
  for (let index = 0; index < decoded.data.length; index += 4) {
    colors.add(decoded.data.subarray(index, index + 4).toString("hex"));
    if (colors.size >= 32) break;
  }
  return { width: decoded.width, height: decoded.height, uniqueColors: colors.size };
}
```

- [ ] **Step 2: Extend the editor/MCP test harness**

Change `launchEditor` to accept `{ scene?: string; headless?: boolean }`. Default `headless` to true for existing Phase 0-1 tests. For Phase 2 capture tests on macOS, spawn without `--headless` and append the `res://...tscn` scene argument. Preserve PID-owned shutdown and captured stdout/stderr.

Change `McpClientProcess.callTool` to return `{ structuredContent, content }`, copying text/image/resource blocks from the SDK response so tests can decode the actual image. Never log image base64 in failure output; log only block types and byte lengths.

- [ ] **Step 3: Add real-editor observation integration**

Against a disposable initialized fixture with `editor_2d.tscn` open, assert:

- `editor_state` names the open/edited scene and reports no unsaved scene.
- `scene_tree` returns the exact known node paths/classes/groups and truncates at requested depth/count.
- `node` returns the signal, groups, script path, resource metadata, and encoded exported values without script source.
- `resources` returns the `.tscn`, `.gd`, and `.tres` paths from EditorFileSystem in sorted pages.
- `project_settings` accepts `rendering/` and rejects non-approved prefixes before bridge dispatch.
- A fixture warning appears through `diagnostics` redacted and sequence-pageable.
- `diffFromOriginal()` is `[]` after server/editor shutdown and addon uninstall.

- [ ] **Step 4: Add visible-editor 2D and 3D capture integration**

Run two isolated disposable editor sessions, one per fixture scene. For each returned MCP image block:

```ts
const image = result.content.find((block) => block.type === "image");
expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
const png = Buffer.from(image.data, "base64");
const inspected = inspectPng(png);
expect(inspected.width).toBeGreaterThan(64);
expect(inspected.height).toBeGreaterThan(64);
expect(inspected.width).toBeLessThanOrEqual(1280);
expect(inspected.height).toBeLessThanOrEqual(720);
expect(inspected.uniqueColors).toBeGreaterThan(1);
```

Verify the structured SHA-256 matches the bytes, the evidence PNG exists internally, no base64 appears in audit JSONL, and project diff is zero. Skip this test with an explicit message on non-macOS platforms; Phase 2 certification remains macOS-only.

- [ ] **Step 5: Add hostile observation tests**

Cover and assert stable failures for: unopened scene path, `file://`/absolute/traversal paths, stale request after disconnect, expired command deadline, 33rd queued command, node/property/depth/resource/diagnostic limits, serialized query over 512 KiB, duplicate/out-of-order/oversized/incorrect-digest chunks, capture over 8 MiB, secret-like project setting name, diagnostic token/path redaction, binary WebSocket frame, and a frame over one MiB. For every case assert unchanged `project.godot`, no source checkout diff, no raw secret in audit/editor output, and cleanup of pending requests/chunks.

- [ ] **Step 6: Add published stdio Phase 2 E2E**

Start an initialized disposable fixture with `editor_2d.tscn`, connect through `packages/cli/dist/bin.js`, and assert:

1. exactly six tools are listed;
2. `godot_query(editor_state)` reports attached fixture truth;
3. `godot_query(node)` reports `phase-2-2d` metadata;
4. `godot_capture(2d)` returns a nonblank PNG image block and evidence URI;
5. audit records exist for both calls without image data/secrets;
6. shutdown, disable, and uninstall leave zero project diff and no runtime descriptor.

Preserve failure artifacts using metadata-only capture receipts, audit JSONL, editor output, and MCP stderr. Do not copy PNG contents into text logs.

- [ ] **Step 7: Run focused acceptance and commit**

Run:

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm build
GODOT_BIN=/opt/homebrew/bin/godot pnpm exec vitest run tests/integration/editor-observation.test.ts tests/integration/editor-capture.test.ts
GODOT_BIN=/opt/homebrew/bin/godot pnpm exec vitest run tests/security/editor-observation-hostile.test.ts
GODOT_BIN=/opt/homebrew/bin/godot pnpm exec vitest run tests/end-to-end/phase-2.test.ts
```

Expected: PASS; both PNGs are valid/nonblank and every disposable project reports zero diff.

```bash
git add fixtures/godot-4.7/observation packages/testkit/package.json packages/testkit/src/e2e.ts tests/integration/editor-observation.test.ts tests/integration/editor-capture.test.ts tests/security/editor-observation-hostile.test.ts tests/end-to-end/phase-2.test.ts pnpm-lock.yaml
git commit -m "test: certify editor observation and capture"
```

### Task 7: Add the Phase 2 gate and operator documentation

**Files:**
- Create: `scripts/qa-phase-2.mjs`
- Modify: `package.json`
- Create: `docs/testing/phase-2.md`
- Modify: `docs/protocol/bridge-v1.md`
- Modify: `docs/security/threat-model.md`
- Modify: `README.md`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces `pnpm qa:phase-2` as the authoritative local and CI gate.
- Documents exact Phase 2 scope, wire messages, limits, redaction, visible-editor requirement, evidence location, and cleanup proof.

- [ ] **Step 1: Write the Phase 2 gate**

Base `scripts/qa-phase-2.mjs` on the Phase 0-1 gate and preserve the exact engine check `4.7.stable.official.5b4e0cb0f`. Run in this order:

```text
1/13 generated protocol drift
2/13 topological package builds
3/13 ESLint
4/13 TypeScript typecheck
5/13 package unit tests
6/13 Godot fixture import
7/13 GDScript protocol fixture
8/13 GDScript observation unit harness
9/13 real-editor observation integration
10/13 visible-editor viewport integration
11/13 observation security matrix
12/13 published stdio Phase 2 E2E
13/13 git diff --check
```

Use disposable fixture copies for steps 7 and 8. Set a persistent failure-artifact directory only for metadata/audit/log receipts. Add `"qa:phase-2": "node scripts/qa-phase-2.mjs"` to `package.json`.

- [ ] **Step 2: Document the wire and threat model**

In `bridge-v1.md`, specify `editor.query`, `editor.capture`, `command.chunk`, and `command.result`, canonical signed-envelope ordering, request IDs, deadlines, chunk order/digest/size limits, terminal result rules, and disconnect cleanup. State that binary WebSocket frames remain forbidden.

In `threat-model.md`, add abuse cases for scene/resource enumeration, secret-bearing settings/logs, oversized trees/properties/diagnostics, capture memory pressure, decompression/encoding cost, chunk confusion, stale responses, hidden editor viewport assumptions, and evidence path leakage. Map each to the concrete bounds/redaction/identity/deadline controls in this plan.

- [ ] **Step 3: Document operation and testing behavior**

`docs/testing/phase-2.md` must state:

- exact prerequisites and gate command;
- why viewport tests use a visible disposable macOS editor while other tests stay headless;
- the six query variants and capture bounds;
- how nonblank PNGs, SHA-256, audit redaction, and zero project diff are verified;
- which failure artifacts are retained and that image base64 is excluded from text logs;
- Phase 2 limitations: open scenes only, indexed metadata only, no script source, no runtime, input, mutation, debug, build, export, or evidence retrieval tool yet.

Update README capability examples and keep roadmap features clearly labeled unimplemented.

- [ ] **Step 4: Extend CI without weakening Phase 0-1**

Keep the existing Phase 0-1 job. Add a macOS Phase 2 job using the same pinned universal Godot archive/SHA-512 and run `pnpm qa:phase-2`. Ensure the job has a real WindowServer-capable session; if hosted CI cannot render visible editor viewports, fail with an explicit unsupported-runner message rather than silently switching to headless or marking captures passed. Upload only failure receipts/logs, not pairing descriptors or raw capture PNGs.

- [ ] **Step 5: Run both authoritative gates**

Run:

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-0-1
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-2
```

Expected: both print `PASS`; Phase 2 reports 13 completed stages, nonblank 2D/3D captures, hostile checks, E2E cleanup, and `git diff --check` success.

- [ ] **Step 6: Commit documentation and gate**

```bash
git add scripts/qa-phase-2.mjs package.json docs/testing/phase-2.md docs/protocol/bridge-v1.md docs/security/threat-model.md README.md .github/workflows/ci.yml
git commit -m "docs: add Phase 2 certification gate"
```

---

## Self-review against the master design

- Phase 2 project/editor state: Task 3 `editor_state` and Task 6 fixture truth.
- Open scenes, selections, trees, nodes, resources, scripts, signals, groups, settings, and imports: Task 3 bounded query variants and Task 6 integration assertions.
- Output, warnings, and errors: Task 3 thread-safe diagnostic logger and Task 6 redaction/paging checks.
- Real 2D and 3D editor viewport images: Task 4 capture/chunk/evidence path and Task 6 visible-editor PNG assertions.
- Structured reads match fixture truth: Task 6 observation integration and published stdio E2E.
- Observation leaves no project diff: Task 6 checks after query, capture, shutdown, disable, and uninstall.
- Earlier security invariants remain intact: one-MiB frames, signed envelopes, sequence/deadline checks, project identity, redacted audit, no arbitrary load/read/mutation, and Phase 0-1 gate rerun.
- Roadmap boundary remains intact: Phase 2 adds no runtime bridge, input, mutation, debugging, project operation, unsafe execution, or arbitrary method invocation.

No later-phase subsystem is required to accept Phase 2. The evidence URI is intentionally write-only in this phase because the inline image satisfies capture delivery; `godot_evidence` retrieval belongs to a later focused plan.
