# Phase 7 Debugging and Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add native, read-only GDScript debugging and cancellable structured performance profiling to the existing authenticated MCP-owned runtime without adding tools or widening normal-profile authority.

**Architecture:** Extend `godot_runtime` with strict Phase 7 operation variants. A minimal TypeScript DAP client attaches only after the existing owned runtime is authenticated and only after the editor PID is proven to own the loopback DAP listener; the Godot runtime harness separately samples public performance/profiler APIs. Opaque stop-bound tokens, bounded data, serialized requests, and one idempotent cleanup path prevent stale or cross-run state.

**Tech Stack:** Node.js 22, TypeScript 6, Zod, MCP SDK, pnpm 11, Vitest 4, TCP DAP framing, Godot 4.7 GDScript, `EditorDebuggerSession`, `Performance`, `EngineProfiler`, `RenderingServer`, `RenderingDevice`.

## Global Constraints

- Keep MCP on stdio; editor debugger and DAP listeners bind only to `127.0.0.1`.
- The default session exposes exactly six observe-only tools; runtime authorization still adds exactly `godot_runtime` and `godot_runtime_capture`.
- Phase 7 adds no permission tier, capability pack, raw DAP tool, or arbitrary protocol passthrough.
- DAP may send only initialize, attach, disconnect, setBreakpoints, threads, stackTrace, scopes, variables, pause, continue, next, and stepIn.
- Never send DAP launch, restart, terminate, evaluate, setVariable, or `godot_put_msg`.
- Breakpoints target canonical project-local `.gd` files and never `res://addons/godot_mcp`.
- Watches traverse returned variables by exact name/index; they never evaluate expressions or invoke methods.
- All debugger IDs exposed through MCP are opaque and bound to run ID, generation, DAP generation, and stop-event sequence.
- One profiling job may retain at most 2,048 samples and 4 MiB; duration is 100 ms–30 s.
- Audit logs contain no source text, variable/watch values, monitor samples, or raw profiler evidence.
- All editor, DAP, debugger, profiler, hostile-input, and E2E tests use disposable fixture copies.
- Before Phase 8, run `GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-7`, Phase 0–6 regression gates, and autoreview; fix accepted findings and rerun affected proof.

---

## File Responsibility Map

```text
packages/protocol/src/runtimeDebug.ts                    Strict Phase 7 debugger inputs/results and token shapes
packages/protocol/src/runtimePerformance.ts              Monitor/profile inputs, evidence, receipts, and bounds
packages/protocol/src/runtime.ts                         Compose Phase 3 and Phase 7 runtime operations
packages/control-plane/src/runtime/dapFraming.ts         One-MiB Content-Length parser/encoder
packages/control-plane/src/runtime/dapClient.ts          Closed-world serialized DAP client and event queue
packages/control-plane/src/runtime/debugTokenStore.ts    Stop-bound opaque frame/variable/job tokens
packages/control-plane/src/runtime/runtimeService.ts     Runtime/DAP/job lifecycle and Phase 7 routing
packages/control-plane/src/runtime/runtimeProcess.ts     Verified editor ownership for debugger and DAP listeners
packages/cli/src/runtime/createRuntime.ts                 Supply DAP transport dependencies to RuntimeService
addons/godot_mcp/plugin.gd                               Report configured loopback DAP port during prepare
addons/godot_mcp/runtime/runtime_debugger.gd              Bind prepare response to editor PID/debug/DAP ports
addons/godot_mcp/runtime/runtime_profiler.gd              Bounded public Performance/EngineProfiler sampler
addons/godot_mcp/runtime/runtime_harness.gd               Monitor and profile runtime command routing/cleanup
fixtures/godot-4.7/debug/**                               Deterministic breakpoints, stacks, values, errors, workloads
tests/integration/runtime-debugging.test.ts               Real DAP breakpoint/stack/watch/control proof
tests/integration/runtime-performance.test.ts             Complete/cancelled/failed structured evidence proof
tests/security/runtime-debugging-hostile.test.ts          DAP/path/token/framing/authorization attacks
tests/end-to-end/phase-7.test.ts                          Published stdio Phase 7 acceptance
scripts/qa-phase-7.mjs                                    Ordered Phase 7 gate
scripts/verify-phase-7-cleanup.mjs                        Process/port/descriptor/lease/job/fixture verifier
docs/testing/phase-7.md                                   Certified contract, prerequisites, stages, exclusions
```

## Task 1: Define strict Phase 7 protocol variants

**Files:**
- Create: `packages/protocol/src/runtimeDebug.ts`
- Create: `packages/protocol/src/runtimeDebug.test.ts`
- Create: `packages/protocol/src/runtimePerformance.ts`
- Create: `packages/protocol/src/runtimePerformance.test.ts`
- Modify: `packages/protocol/src/runtime.ts`
- Modify: `packages/protocol/src/runtime.test.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/mcp-server/src/registerRuntimeTools.test.ts`

**Interfaces:**
- Produces: `RuntimeDebugOperationInputSchema`, `RuntimePerformanceOperationInputSchema`, `DebugFrameTokenSchema`, `DebugVariableTokenSchema`, `ProfileJobTokenSchema`, `MonitorSnapshotSchema`, `ProfileEvidenceSchema`.
- Consumes: existing `RuntimeHandleSchema`, `RuntimeOperationInputSchema`, runtime authorization, and unchanged runtime tool registration.

- [ ] **Step 1: Write failing schema and tool-count tests**

Add exact acceptance and rejection cases:

```ts
import { describe, expect, it } from "vitest";
import {
  RuntimeDebugOperationInputSchema,
  RuntimePerformanceOperationInputSchema,
} from "./index.js";

const handle = { runId: "00000000-0000-4000-8000-000000000001", generation: 1 };

it("accepts bounded project-local breakpoints", () => {
  expect(RuntimeDebugOperationInputSchema.parse({
    operation: "debug_breakpoints_set",
    handle,
    breakpoints: [{ sourcePath: "res://debug/debug_fixture.gd", line: 17 }],
  })).toMatchObject({ operation: "debug_breakpoints_set" });
});

it.each([
  "res://../escape.gd",
  "res://addons/godot_mcp/plugin.gd",
  "res://debug/not_script.txt",
])("rejects debugger source %s", (sourcePath) => {
  expect(() => RuntimeDebugOperationInputSchema.parse({
    operation: "debug_breakpoints_set", handle,
    breakpoints: [{ sourcePath, line: 1 }],
  })).toThrow();
});

it("accepts only selector watches", () => {
  expect(RuntimeDebugOperationInputSchema.parse({
    operation: "debug_watch", handle,
    ...withFrameReference(stack.frames[0]),
    selectors: [{ scope: "locals", path: ["player", "health"] }],
  })).toMatchObject({ operation: "debug_watch" });
});

it("bounds profile captures", () => {
  expect(RuntimePerformanceOperationInputSchema.parse({
    operation: "profile_start", handle, durationMs: 1000,
    intervalFrames: 1, groups: ["frame", "memory"], retainRaw: true,
  })).toMatchObject({ operation: "profile_start" });
  expect(() => RuntimePerformanceOperationInputSchema.parse({
    operation: "profile_start", handle, durationMs: 30001,
    intervalFrames: 1, groups: ["frame"], retainRaw: true,
  })).toThrow();
});
```

Update `registerRuntimeTools.test.ts` to assert observe-only remains six tools and runtime remains exactly eight tools, with Phase 7 variants accepted by the one existing `godot_runtime` input schema.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm exec vitest run packages/protocol/src/runtimeDebug.test.ts packages/protocol/src/runtimePerformance.test.ts packages/mcp-server/src/registerRuntimeTools.test.ts`

Expected: FAIL because the Phase 7 modules and exports do not exist.

- [ ] **Step 3: Implement strict schemas and composed operation types**

Use opaque token schemas with fixed prefixes and 256-bit base64url payloads:

```ts
const opaque = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]{43}$`));
export const DebugFrameTokenSchema = opaque("dft");
export const DebugVariableTokenSchema = opaque("dvt");
export const ProfileJobTokenSchema = opaque("pjt");
```

Define exact debugger operations:

```ts
export const RUNTIME_DEBUG_OPERATIONS = [
  "debug_breakpoints_set", "debug_status", "debug_wait", "debug_pause",
  "debug_continue", "debug_step_over", "debug_step_into", "debug_stack",
  "debug_variables", "debug_children", "debug_watch",
] as const;
```

Define exact performance operations:

```ts
export const RUNTIME_PERFORMANCE_OPERATIONS = [
  "monitor_snapshot", "profile_start", "profile_status", "profile_cancel", "profile_result",
] as const;
```

Apply the spec's 64-breakpoint/16-file, 64-frame, 256-entry/page, depth-eight, 32-selector, 30-second, 2,048-sample, and 4-MiB bounds. Compose both unions into `RuntimeOperationInputSchema` without changing existing Phase 3 variants.

- [ ] **Step 4: Pass focused tests and commit**

Run: `pnpm exec vitest run packages/protocol/src/runtimeDebug.test.ts packages/protocol/src/runtimePerformance.test.ts packages/protocol/src/runtime.test.ts packages/mcp-server/src/registerRuntimeTools.test.ts`

Expected: PASS.

```bash
git add packages/protocol/src/runtimeDebug.ts packages/protocol/src/runtimeDebug.test.ts packages/protocol/src/runtimePerformance.ts packages/protocol/src/runtimePerformance.test.ts packages/protocol/src/runtime.ts packages/protocol/src/runtime.test.ts packages/protocol/src/index.ts packages/mcp-server/src/registerRuntimeTools.test.ts
git commit -m "feat: define Phase 7 runtime contracts"
```

## Task 2: Implement closed-world DAP framing and transport

**Files:**
- Create: `packages/control-plane/src/runtime/dapFraming.ts`
- Create: `packages/control-plane/src/runtime/dapFraming.test.ts`
- Create: `packages/control-plane/src/runtime/dapClient.ts`
- Create: `packages/control-plane/src/runtime/dapClient.test.ts`
- Modify: `packages/control-plane/src/index.ts`

**Interfaces:**
- Produces: `DapFrameParser`, `encodeDapMessage`, `DapClient.connect(input)`, `DapClient.request(command, arguments, timeoutMs)`, `DapClient.nextStop(afterSequence, timeoutMs)`, and `DapClient.close()`.
- Consumes: Node `net.Socket`, verified loopback host/port supplied by RuntimeService, and the public Godot 4.7 DAP subset.

- [ ] **Step 1: Write failing framing and client tests**

Cover split headers/bodies, multiple frames per chunk, CRLF-only headers, duplicate/missing/invalid/oversized Content-Length, invalid JSON, response correlation, out-of-order responses, timeout, unknown response ID, event overflow, stopped/continued/terminated events, and close rejection.

```ts
it("parses fragmented DAP frames", () => {
  const parser = new DapFrameParser();
  expect(parser.push(Buffer.from("Content-Length: 16\r\n\r\n{\"type\":\"event\""))).toEqual([]);
  expect(parser.push(Buffer.from("}"))).toEqual([{ type: "event" }]);
});

it("rejects forbidden outbound commands", async () => {
  const client = await connectedClient();
  await expect(client.request("evaluate", { expression: "quit()" }, 1000))
    .rejects.toMatchObject({ code: "INVALID_REQUEST" });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm exec vitest run packages/control-plane/src/runtime/dapFraming.test.ts packages/control-plane/src/runtime/dapClient.test.ts`

Expected: FAIL because the DAP modules do not exist.

- [ ] **Step 3: Implement one-MiB framing and a serialized allowlisted client**

`DapFrameParser` retains at most one header plus one 1-MiB body. `encodeDapMessage` uses UTF-8 byte length. `DapClient` permits only:

```ts
const ALLOWED_DAP_COMMANDS = new Set([
  "initialize", "attach", "disconnect", "setBreakpoints", "threads",
  "stackTrace", "scopes", "variables", "pause", "continue", "next", "stepIn",
]);
```

Serialize requests with one promise tail, positive sequence IDs, a 10-second maximum deadline, a 512-event queue, and fail-closed handling for framing/correlation/type violations. Initialize with one-based lines/columns and variable types, then attach to the already-running project; never issue launch/configurationDone.

- [ ] **Step 4: Pass focused tests and commit**

Run: `pnpm exec vitest run packages/control-plane/src/runtime/dapFraming.test.ts packages/control-plane/src/runtime/dapClient.test.ts`

Expected: PASS.

```bash
git add packages/control-plane/src/runtime/dapFraming.ts packages/control-plane/src/runtime/dapFraming.test.ts packages/control-plane/src/runtime/dapClient.ts packages/control-plane/src/runtime/dapClient.test.ts packages/control-plane/src/index.ts
git commit -m "feat: add contained Godot DAP client"
```

## Task 3: Bind DAP and opaque debugger state to the owned runtime

**Files:**
- Create: `packages/control-plane/src/runtime/debugTokenStore.ts`
- Create: `packages/control-plane/src/runtime/debugTokenStore.test.ts`
- Modify: `packages/control-plane/src/runtime/runtimeProcess.ts`
- Modify: `packages/control-plane/src/runtime/runtimeProcess.test.ts`
- Modify: `packages/control-plane/src/runtime/runtimeService.ts`
- Modify: `packages/control-plane/src/runtime/runtimeService.test.ts`
- Modify: `packages/cli/src/runtime/createRuntime.ts`
- Modify: `packages/cli/src/runtime/createRuntime.test.ts`

**Interfaces:**
- Produces: stop-bound token issuance/resolution and RuntimeService routing for all `debug_*` operations.
- Consumes: `DapClient`, editor PID/debug/DAP ports, active runtime handle, project path policy, and existing serialized runtime operation queue.

- [ ] **Step 1: Write failing ownership, token, and lifecycle tests**

Assert:

- Runtime launch rejects missing/invalid DAP port and a DAP listener not owned by the recorded editor PID.
- DAP connects only after authenticated runtime PID equality.
- Breakpoints canonicalize/group by file and reject addon/symlink/traversal paths.
- Stack tokens cannot be reused after continue, step, new stop, reconnect, or generation change.
- Variable and watch traversal enforce page/depth/total bounds and never call DAP evaluate.
- Step waits for a new stopped event and times out cleanly.
- Stop, crash, disconnect, and close clear MCP breakpoints and close DAP exactly once.

```ts
it("invalidates frame tokens on continue", async () => {
  const service = launchedDebugService();
  const stack = await service.execute({ operation: "debug_stack", handle });
  await service.execute({ operation: "debug_continue", handle });
  await expect(service.execute({
    operation: "debug_variables", handle,
    ...withFrameReference(stack.frames[0]), scope: "locals", offset: 0, limit: 100,
  })).rejects.toMatchObject({ code: "STALE_HANDLE" });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm exec vitest run packages/control-plane/src/runtime/debugTokenStore.test.ts packages/control-plane/src/runtime/runtimeProcess.test.ts packages/control-plane/src/runtime/runtimeService.test.ts packages/cli/src/runtime/createRuntime.test.ts`

Expected: FAIL on missing token store and Phase 7 dependencies.

- [ ] **Step 3: Implement listener ownership and debugger lifecycle**

Generalize the existing listener proof to verify both ports against the same editor PID:

```ts
export async function assertLoopbackListenersOwnedByProcess(
  pid: number,
  ports: readonly number[],
): Promise<void> {
  for (const port of new Set(ports)) await assertLoopbackListenerOwnedByProcess(pid, port);
}
```

Extend prepare to return `{ debugPort, dapPort, editorPid }`. After `await_ready` validates the owned PID, connect DAP, initialize, attach, and bind a new DAP generation. Implement `DebugTokenStore` with random 32-byte tokens and maps whose records include run/generation/DAP/stop identity. Clear the store on every execution transition and cleanup.

Route debugger operations through private focused methods; keep the existing harness operations unchanged. Resolve variables on demand and enforce 2,048 total variables per stop. Watch selectors must use `scopes` and `variables` only.

- [ ] **Step 4: Pass focused tests and commit**

Run: `pnpm exec vitest run packages/control-plane/src/runtime/debugTokenStore.test.ts packages/control-plane/src/runtime/dapClient.test.ts packages/control-plane/src/runtime/runtimeProcess.test.ts packages/control-plane/src/runtime/runtimeService.test.ts packages/cli/src/runtime/createRuntime.test.ts`

Expected: PASS.

```bash
git add packages/control-plane/src/runtime/debugTokenStore.ts packages/control-plane/src/runtime/debugTokenStore.test.ts packages/control-plane/src/runtime/runtimeProcess.ts packages/control-plane/src/runtime/runtimeProcess.test.ts packages/control-plane/src/runtime/runtimeService.ts packages/control-plane/src/runtime/runtimeService.test.ts packages/cli/src/runtime/createRuntime.ts packages/cli/src/runtime/createRuntime.test.ts
git commit -m "feat: integrate owned runtime debugging"
```

## Task 4: Add public Godot monitor and profiler sampling

**Files:**
- Create: `addons/godot_mcp/runtime/runtime_profiler.gd`
- Create: `fixtures/godot-4.7/tests/runtime_profiler_unit.gd`
- Modify: `addons/godot_mcp/runtime/runtime_harness.gd`
- Modify: `fixtures/godot-4.7/project.godot`

**Interfaces:**
- Produces: `RuntimeProfiler.snapshot(groups)`, `start(input)`, `status(job_token)`, `cancel(job_token)`, `result(job_token)`, and `clear()`.
- Consumes: public `Performance`, a local `EngineProfiler` subclass, `RenderingServer`, optional `RenderingDevice`, frame callbacks, and authenticated harness commands.

- [ ] **Step 1: Write failing Godot unit assertions**

The unit script must assert group selection, finite numeric values, stable ordering, custom-monitor bounds, one-job conflict, completed aggregates, raw-retention cap, deterministic downsampling, cancellation with partial evidence, stale token rejection, digest stability, unsupported GPU metadata, and idempotent clear.

```gdscript
var profiler := RuntimeProfiler.new()
var snapshot := profiler.snapshot(["frame", "memory"])
assert(snapshot.ok)
assert(snapshot.data.groups.has("frame"))
var started := profiler.start({"durationMs": 100, "intervalFrames": 1, "groups": ["frame"], "retainRaw": true})
assert(started.ok)
assert(not profiler.start({"durationMs": 100, "intervalFrames": 1, "groups": ["frame"], "retainRaw": true}).ok)
```

- [ ] **Step 2: Run the Godot unit and verify RED**

Run: `GODOT_BIN=/opt/homebrew/bin/godot pnpm build && /opt/homebrew/bin/godot --headless --path fixtures/godot-4.7 --script res://tests/runtime_profiler_unit.gd`

Expected: non-zero because `runtime_profiler.gd` does not exist.

- [ ] **Step 3: Implement bounded public sampling and async job state**

Map only documented monitor constants into fixed groups. Enumerate public custom monitors, accept finite numeric values, and cap names at 128 bytes. Register a local `EngineProfiler` subclass during an active job; `_tick(frame_time, process_time, physics_time, physics_frame_time)` forwards those four values to the sampler.

Advance jobs from the harness process callback without blocking the debugger command loop. Retain at most 2,048 raw samples and calculate min/max/mean/p50/p95/p99 from bounded numeric arrays at finalization. Canonicalize evidence with the existing canonical JSON helper and hash it. Use RenderingDevice captured timestamps only when the public API reports support; otherwise emit `{ supported: false }`.

Add `monitor_snapshot`, `profile_start`, `profile_status`, `profile_cancel`, and `profile_result` to the harness allowlist and dispatch. Call `clear()` from runtime exit, scene invalidation, and cooperative stop.

- [ ] **Step 4: Pass the Godot unit and commit**

Run: `/opt/homebrew/bin/godot --headless --path fixtures/godot-4.7 --script res://tests/runtime_profiler_unit.gd`

Expected: exit 0 with `PHASE7_PROFILER_UNIT_OK`.

```bash
git add addons/godot_mcp/runtime/runtime_profiler.gd addons/godot_mcp/runtime/runtime_harness.gd fixtures/godot-4.7/tests/runtime_profiler_unit.gd fixtures/godot-4.7/project.godot
git commit -m "feat: capture bounded runtime profiles"
```

## Task 5: Expose DAP port and complete performance routing

**Files:**
- Modify: `addons/godot_mcp/plugin.gd`
- Modify: `addons/godot_mcp/runtime/runtime_debugger.gd`
- Modify: `fixtures/godot-4.7/tests/runtime_harness_unit.gd`
- Modify: `packages/control-plane/src/runtime/runtimeService.ts`
- Modify: `packages/control-plane/src/runtime/runtimeService.test.ts`
- Modify: `packages/mcp-server/src/registerRuntimeTools.ts`
- Modify: `packages/mcp-server/src/registerRuntimeTools.test.ts`

**Interfaces:**
- Produces: `{ debugPort, dapPort, editorPid }` prepare response and end-to-end monitor/profile routing through the unchanged `godot_runtime` tool.
- Consumes: Phase 7 protocol schemas, harness performance commands, existing `executeTool`, policy, and audit wrappers.

- [ ] **Step 1: Write failing addon/service/MCP tests**

Assert DAP port override `--godot-mcp-dap-port=<port>` wins over editor settings, invalid ports fail prepare, performance results parse strictly, job tokens are bound to the current run, runtime tool annotations remain closed-world, and audit summaries contain only group/count/duration/digest metadata.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm exec vitest run packages/control-plane/src/runtime/runtimeService.test.ts packages/mcp-server/src/registerRuntimeTools.test.ts`

Expected: FAIL because performance variants and DAP prepare data are not routed.

- [ ] **Step 3: Implement prepare and routing**

Add `_runtime_dap_port()` beside `_runtime_debug_port()` and pass it into `runtime_debugger.prepare`. Validate the spec's range and return it unchanged. In TypeScript, forward monitor/profile operations through `dependencies.command`, parse every terminal result with its protocol schema, verify job token/run identity, and compute audit metadata without values.

Keep one `godot_runtime` registration and existing tool annotations. `launch` still uses the dedicated method; all other Phase 3 and Phase 7 variants use `runtime.execute`.

- [ ] **Step 4: Pass focused tests and commit**

Run: `pnpm exec vitest run packages/control-plane/src/runtime/runtimeService.test.ts packages/mcp-server/src/registerRuntimeTools.test.ts packages/mcp-server/src/executeTool.test.ts`

Expected: PASS.

```bash
git add addons/godot_mcp/plugin.gd addons/godot_mcp/runtime/runtime_debugger.gd fixtures/godot-4.7/tests/runtime_harness_unit.gd packages/control-plane/src/runtime/runtimeService.ts packages/control-plane/src/runtime/runtimeService.test.ts packages/mcp-server/src/registerRuntimeTools.ts packages/mcp-server/src/registerRuntimeTools.test.ts
git commit -m "feat: integrate Phase 7 runtime evidence"
```

## Task 6: Certify real debugging and performance behavior

**Files:**
- Create: `fixtures/godot-4.7/debug/debug_fixture.gd`
- Create: `fixtures/godot-4.7/debug/debug_fixture.tscn`
- Create: `fixtures/godot-4.7/debug/debug_remote_object.gd`
- Create: `tests/integration/runtime-debugging.test.ts`
- Create: `tests/integration/runtime-performance.test.ts`
- Modify: `packages/testkit/src/e2e.ts`
- Modify: `packages/testkit/src/godot.ts`

**Interfaces:**
- Produces: deterministic real-Godot proof for native DAP and public profiler evidence.
- Consumes: disposable fixture copies, explicit debug-server and DAP ports, owned runtime launch, Phase 7 runtime operations, and cleanup helpers.

- [ ] **Step 1: Add fixture truth and failing integrations**

The fixture script must have stable marked lines for two breakpoints, nested `outer -> middle -> inner` calls, locals/members/globals/arrays/dictionaries/vectors/remote object fields, a deliberate `assert(false, "PHASE7_DELIBERATE_ERROR")`, custom monitors, deterministic object allocation, draw workload, and a cancellable long workload.

Integration assertions must cover:

```ts
const set = await runtime.execute({
  operation: "debug_breakpoints_set", handle,
  breakpoints: [{ sourcePath: "res://debug/debug_fixture.gd", line: fixtureLines.inner }],
});
expect(set.breakpoints[0].verified).toBe(true);
const stopped = await runtime.execute({ operation: "debug_wait", handle, timeoutMs: 10_000 });
expect(stopped.reason).toBe("breakpoint");
const stack = await runtime.execute({ operation: "debug_stack", handle });
expect(stack.frames.map((frame) => frame.name)).toEqual(expect.arrayContaining(["inner", "middle", "outer"]));
```

Performance tests assert expected group names, finite metrics, completed evidence and digest, deterministic workload direction rather than machine-specific absolute timing, cancellation with bounded partial evidence, and cleanup after runtime crash.

- [ ] **Step 2: Run integrations and verify RED**

Run: `GODOT_BIN=/opt/homebrew/bin/godot pnpm exec vitest run tests/integration/runtime-debugging.test.ts tests/integration/runtime-performance.test.ts --fileParallelism=false`

Expected: FAIL until fixture, DAP port plumbing, and complete runtime behavior exist.

- [ ] **Step 3: Implement testkit DAP port isolation and make integrations pass**

Reserve a distinct loopback DAP port for each disposable editor. Launch the editor with `--dap-port <port>` and pass `--godot-mcp-dap-port=<port>` as a user argument. Record editor PID and both listener ports in the fixture handle. Ensure close waits for DAP disconnect, runtime process exit, and editor exit.

Run: `GODOT_BIN=/opt/homebrew/bin/godot pnpm exec vitest run tests/integration/runtime-debugging.test.ts tests/integration/runtime-performance.test.ts --fileParallelism=false`

Expected: PASS.

- [ ] **Step 4: Commit real-Godot proof**

```bash
git add fixtures/godot-4.7/debug tests/integration/runtime-debugging.test.ts tests/integration/runtime-performance.test.ts packages/testkit/src/e2e.ts packages/testkit/src/godot.ts
git commit -m "test: verify Phase 7 runtime evidence"
```

## Task 7: Add hostile-input, cleanup, and published stdio proof

**Files:**
- Create: `tests/security/runtime-debugging-hostile.test.ts`
- Create: `tests/end-to-end/phase-7.test.ts`
- Create: `scripts/verify-phase-7-cleanup.mjs`
- Modify: `tests/meta/workspace.test.ts`
- Modify: `docs/security/threat-model.md`
- Modify: `docs/protocol/bridge-v1.md`

**Interfaces:**
- Produces: adversarial, lifecycle, and installed-package evidence plus documented security boundary.
- Consumes: hostile fake DAP peers, disposable projects, published CLI/stdin transport, grants/packs, and cleanup inspection.

- [ ] **Step 1: Write failing hostile and E2E tests**

Cover missing runtime grants, raw tool-count stability, traversal/symlink/addon breakpoints, duplicate sources, huge lines/arrays, stale run/frame/variable/job tokens, forged stop events, malformed/duplicate/oversized Content-Length, invalid JSON, unknown response IDs, event overflow, late responses, DAP listener PID replacement, DAP loss during step, runtime crash during profile, editor disconnect, MCP shutdown, and audit value redaction.

Published stdio E2E launches a disposable editor and runtime, hits a breakpoint, reads one safe watch, continues, captures a monitor snapshot, completes and cancels profiles, stops, and proves no remaining owned state.

- [ ] **Step 2: Run tests and verify RED**

Run: `GODOT_BIN=/opt/homebrew/bin/godot pnpm exec vitest run tests/security/runtime-debugging-hostile.test.ts tests/end-to-end/phase-7.test.ts --fileParallelism=false`

Expected: FAIL until hostile handling, installed surface, and verifier are complete.

- [ ] **Step 3: Complete fail-closed handling, verifier, and docs**

`verify-phase-7-cleanup.mjs` must reject:

- Any fixture diff.
- Runtime descriptors, consuming files, or leases belonging to the test project.
- Phase 7 temporary profile/evidence files.
- Live recorded runtime PIDs.
- Listeners remaining on recorded debug or DAP ports.

It reports offending paths/PIDs/ports and never deletes evidence.

Update the threat model with unauthenticated-loopback DAP, wrong-run attachment, stale-token disclosure, variable-value exposure, event overflow, and profiling resource exhaustion. Update bridge-v1 with verified DAP attachment, allowlisted requests, opaque tokens, performance jobs, bounds, and cleanup.

- [ ] **Step 4: Pass hostile/E2E/meta tests and commit**

Run: `GODOT_BIN=/opt/homebrew/bin/godot pnpm exec vitest run tests/security/runtime-debugging-hostile.test.ts tests/end-to-end/phase-7.test.ts tests/meta/workspace.test.ts --fileParallelism=false`

Expected: PASS.

```bash
git add tests/security/runtime-debugging-hostile.test.ts tests/end-to-end/phase-7.test.ts scripts/verify-phase-7-cleanup.mjs tests/meta/workspace.test.ts docs/security/threat-model.md docs/protocol/bridge-v1.md
git commit -m "test: certify Phase 7 security boundaries"
```

## Task 8: Add the Phase 7 gate and current documentation

**Files:**
- Create: `scripts/qa-phase-7.mjs`
- Create: `docs/testing/phase-7.md`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `pnpm qa:phase-7`, CI coverage, exact testing contract, and current capability docs.
- Consumes: Tasks 1–7 and all prior phase gates.

- [ ] **Step 1: Write the failing workspace/meta expectation**

Require the package script, gate file, testing document, README Phase 7 status, AGENTS current plan/gate, and CI invocation. The gate source must contain all ordered commands listed below.

- [ ] **Step 2: Run meta test and verify RED**

Run: `pnpm exec vitest run tests/meta/workspace.test.ts`

Expected: FAIL because Phase 7 gate pointers are absent.

- [ ] **Step 3: Implement the 16-stage ordered gate**

`scripts/qa-phase-7.mjs` uses inherited stdio and stops on the first non-zero result:

```text
Godot exact 4.7.stable.official.5b4e0cb0f
node scripts/generate-godot-protocol.mjs --check
pnpm build
pnpm lint
pnpm typecheck
focused Phase 7 protocol/DAP/service/MCP tests
disposable fixture import
Godot runtime profiler and harness units
real debugger/performance integrations
hostile-input suite
published stdio E2E
serialized full Vitest suite
node scripts/verify-phase-7-cleanup.mjs
git diff --check
committed fixture diff check
working-tree diff check
```

Add `qa:phase-7` to `package.json` and CI after Phase 6. Document exact prerequisites, operations, bounds, error/cancellation behavior, public-API limitation, gate, and required Phase 0–6 regressions. Update README without claiming Phase 8–11. Update AGENTS current plan/gate to Phase 7.

- [ ] **Step 4: Pass meta/focused checks and commit**

Run: `pnpm exec vitest run tests/meta/workspace.test.ts packages/protocol/src/runtimeDebug.test.ts packages/protocol/src/runtimePerformance.test.ts packages/mcp-server/src/registerRuntimeTools.test.ts`

Expected: PASS.

```bash
git add scripts/qa-phase-7.mjs docs/testing/phase-7.md package.json README.md AGENTS.md .github/workflows/ci.yml tests/meta/workspace.test.ts
git commit -m "test: add Phase 7 certification gate"
```

## Task 9: Certify, review, and gate Phase 8

**Files:**
- Verify only; modify Phase 7 files only when a failing check or accepted review finding demonstrates a defect.

**Interfaces:**
- Consumes: completed Tasks 1–8 and the autoreview helper.
- Produces: fresh Phase 7 gate evidence, Phase 0–6 regression evidence, and a clean final review.

- [ ] **Step 1: Verify branch state and diff**

Run: `git status --short && git diff --check main...HEAD && git log --oneline main..HEAD`

Expected: clean Phase 7 branch and no whitespace errors.

- [ ] **Step 2: Run the authoritative Phase 7 gate**

Run: `GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-7`

Expected: all 16 stages pass with no skipped stage implied to pass.

- [ ] **Step 3: Run prior-phase regressions serially**

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-0-1
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-2
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-3
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-4
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-5
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-6
```

Expected: every gate passes on the same checkout and Godot binary.

- [ ] **Step 4: Run autoreview on the complete branch diff**

```bash
AUTOREVIEW=/Users/tony/.agents/skills/autoreview/scripts/autoreview
"$AUTOREVIEW" --mode branch --base main --engine codex
```

Expected: exit 0 with `autoreview clean: no accepted/actionable findings reported`.

For each accepted finding, add or adjust a failing test first, implement the minimal fix, rerun the affected focused proof plus `qa:phase-7`, commit, and rerun autoreview. Consciously rejected findings must be recorded with concrete code evidence.

- [ ] **Step 5: Record the green gate**

Run: `git status --short --branch && git log --oneline main..HEAD`

Expected: clean branch containing the approved design, plan, implementation, certification, and any review-fix commits. Only after this evidence is current may the Phase 8 design workflow begin.
