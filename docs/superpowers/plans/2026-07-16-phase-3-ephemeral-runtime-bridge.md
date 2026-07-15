# Phase 3 Ephemeral Runtime Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicitly authorized, MCP-owned Godot debug runtime with bounded observation, waits, lifecycle control, screenshots, and multi-frame evidence.

**Architecture:** The control plane owns one Godot child process and authenticates its installed harness with a one-use runtime descriptor. Runtime commands cross the existing authenticated editor bridge, then a Godot `EditorDebuggerPlugin`/`EngineDebugger` channel; the runtime opens no listener. Two runtime-pack MCP tools expose closed operation unions and reuse Phase 2 result, chunk, evidence, audit, and redaction contracts.

**Tech Stack:** Node.js 22; pnpm 11.13.0; TypeScript 6.0.3; Zod 4.4.3; MCP TypeScript SDK 1.29.0; ws 8.21.0; Vitest 4.1.10; Godot `4.7.stable.official.5b4e0cb0f`; GDScript.

## Global Constraints

- Inherit every Phase 0-2 security, identity, replay, deadline, audit, evidence, redaction, addon-installation, and cleanup invariant.
- Keep MCP on stdio, the editor bridge on authenticated `127.0.0.1`, and runtime traffic on Godot's debugger channel; the runtime opens no listener.
- Runtime tools are visible only with startup grants `{ tiers: ["observe", "runtime_control"], packs: ["core", "runtime"] }`.
- Accept no caller-supplied executable, engine flag, debugger endpoint, environment entry, absolute host path, method name, script, or arbitrary resource load.
- Allow one prepared or active runtime per MCP session and one runtime capture request in flight.
- Keep runtime trees to 1,000 nodes/depth 32, nodes to 128 properties and 128 signals, logs to 500 records, JSON to 512 KiB, waits to 30 seconds, steps to 120 frames, and captures to eight 2048x2048/8 MiB PNGs.
- Use a one-use owner-readable `0600` descriptor with a maximum 60-second expiry and erase secret material after authentication.
- Terminate only an owned PID whose process start fingerprint still matches; never terminate by process name.
- Use disposable copies of `fixtures/godot-4.7` for runtime, crash, hostile-input, and E2E checks; never mutate `/Users/tony/Projects/town-building-game`.
- Follow test-driven development and commit after each task with only that task's files staged.
- Phase 3 completion requires `GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-3`, `qa:phase-0-1`, and `qa:phase-2`.

---

## Planned file map

```text
packages/protocol/src/runtime.ts                    Public runtime schemas and bridge messages
packages/protocol/src/runtime.test.ts               Bounds, closed unions, and stale-handle contracts
packages/control-plane/src/runtime/runtimeDescriptor.ts One-use runtime material
packages/control-plane/src/runtime/runtimeProcess.ts Owned child and fingerprint checks
packages/control-plane/src/runtime/runtimeService.ts Run state machine and cleanup
packages/control-plane/src/runtime/*.test.ts         Descriptor/process/state tests
packages/control-plane/src/policy/capabilities.ts   Runtime-pack policies
packages/control-plane/src/help/coreHelp.ts         Runtime help topics
packages/bridge-client/src/bridgeSession.ts         Runtime editor command methods
packages/cli/src/bin.ts                              Explicit grant/pack flags
packages/cli/src/commands/connect.ts                 Authorized runtime composition
packages/cli/src/runtime/createRuntime.ts            Runtime service lifecycle wiring
packages/mcp-server/src/registerRuntimeTools.ts      Two Phase 3 MCP tools
packages/mcp-server/src/registerRuntimeTools.test.ts Tool, policy, capture, and audit tests
packages/mcp-server/src/executeTool.ts               Ordered image arrays
packages/mcp-server/src/toolResult.ts                Multiple MCP image blocks
packages/mcp-server/src/createServer.ts              Conditional runtime registration
addons/godot_mcp/runtime/runtime_debugger.gd         Editor debugger adapter and binding
addons/godot_mcp/runtime/runtime_harness.gd          Ephemeral runtime instrumentation
addons/godot_mcp/runtime/runtime_harness.tscn        Installed launch scene
addons/godot_mcp/runtime/runtime_logger.gd           Bounded runtime diagnostics
addons/godot_mcp/plugin.gd                           Debugger lifecycle and runtime routing
addons/godot_mcp/bridge/bridge_client.gd             Runtime bridge methods
fixtures/godot-4.7/runtime/runtime_fixture.gd        Deterministic behavior fixture
fixtures/godot-4.7/runtime/runtime_fixture.tscn      Deterministic visual fixture
fixtures/godot-4.7/tests/runtime_harness_unit.gd     GDScript closed-world tests
tests/integration/runtime-bridge.test.ts             Real launch, query, control, capture
tests/security/runtime-hostile.test.ts               Auth, replay, bounds, crash, cleanup
tests/end-to-end/phase-3.test.ts                     Published stdio acceptance
scripts/qa-phase-3.mjs                               Ordered certification gate
docs/protocol/bridge-v1.md                           Phase 3 wire contract
docs/security/threat-model.md                        Runtime threats and mitigations
docs/testing/phase-3.md                              Certification receipt
README.md                                            Phase 3 capability boundary
AGENTS.md                                            Current plan and gate pointers
```

### Task 1: Define runtime schemas, policies, and explicit startup grants

**Files:**
- Create: `packages/protocol/src/runtime.ts`
- Create: `packages/protocol/src/runtime.test.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/control-plane/src/policy/capabilities.ts`
- Modify: `packages/control-plane/src/policy/authorize.test.ts`
- Modify: `packages/control-plane/src/help/coreHelp.ts`
- Modify: `packages/cli/src/bin.ts`
- Modify: `packages/cli/src/commands/connect.ts`
- Modify: `packages/cli/src/runtime/createRuntime.ts`
- Modify: `packages/cli/src/runtime/createRuntime.test.ts`

**Interfaces:**
- Produces `RuntimeHandleSchema = { runId: uuid, generation: int >= 1 }`.
- Produces `RuntimeOperationInputSchema`, `RuntimeCaptureInputSchema`, `RuntimeCommandSchema`, and result types.
- Produces `RUNTIME_POLICY` and `RUNTIME_CAPTURE_POLICY`, each requiring `runtime_control` plus `runtime`.
- Changes `RuntimeOptions` to `{ project: string; grants?: SessionGrants; godotBin?: string }`.

- [ ] **Step 1: Write failing protocol, policy, CLI, and composition tests**

Test exact accepted operations (`launch`, `status`, `tree`, `node`, `logs`, `wait`, `pause`, `resume`, `step`, `stop`) and reject absolute/traversing scene/node paths, `frames: 121`, `frameCount: 9`, and waits above 30 seconds. Assert default visible tools stay six and explicit runtime grants add exactly `godot_runtime` and `godot_runtime_capture`. Assert unknown or incomplete grant/pack combinations fail before startup.

- [ ] **Step 2: Run the focused tests and observe missing schema/policy failures**

```bash
pnpm exec vitest run packages/protocol/src/runtime.test.ts packages/control-plane/src/policy/authorize.test.ts packages/cli/src/runtime/createRuntime.test.ts
```

Expected: FAIL because Phase 3 schemas and policies do not exist.

- [ ] **Step 3: Implement the closed schemas and policies**

Use this public handle and operation shape:

```ts
export const RuntimeHandleSchema = z.object({
  runId: z.uuid(),
  generation: z.number().int().min(1),
}).strict();

export const RuntimeOperationInputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("launch"), scenePath: RuntimeScenePathSchema, startupTimeoutMs: z.number().int().min(1_000).max(30_000).default(15_000) }).strict(),
  z.object({ operation: z.literal("status"), handle: RuntimeHandleSchema.optional() }).strict(),
  z.object({ operation: z.literal("tree"), handle: RuntimeHandleSchema, root: RuntimeNodePathSchema.default("."), maxDepth: z.number().int().min(0).max(32).default(12), maxNodes: z.number().int().min(1).max(1_000).default(500) }).strict(),
  z.object({ operation: z.literal("node"), handle: RuntimeHandleSchema, nodePath: RuntimeNodePathSchema, includeProperties: z.boolean().default(true), includeSignals: z.boolean().default(true) }).strict(),
  z.object({ operation: z.literal("logs"), handle: RuntimeHandleSchema, afterSequence: z.number().int().min(0).default(0), levels: z.array(z.enum(["log", "warning", "error", "script", "shader"])).min(1).max(5).default(["log", "warning", "error", "script", "shader"]), limit: z.number().int().min(1).max(500).default(100) }).strict(),
  RuntimeWaitInputSchema,
  ...["pause", "resume", "stop"].map((operation) => z.object({ operation: z.literal(operation), handle: RuntimeHandleSchema }).strict()),
  z.object({ operation: z.literal("step"), handle: RuntimeHandleSchema, frames: z.number().int().min(1).max(120) }).strict(),
]);
```

Define wait as a discriminated `condition.type` union for the seven approved conditions. Define capture as handle plus `maxWidth`, `maxHeight`, `frameCount`, `intervalFrames`, and `advancePaused`, with the approved bounds.

- [ ] **Step 4: Add explicit connect authorization**

Parse repeatable/comma-separated `--grant` and `--pack` values, allow only `runtime_control` and `runtime` beyond defaults in Phase 3, require them together, and build either:

```ts
{ tiers: ["observe"], packs: ["core"] }
{ tiers: ["observe", "runtime_control"], packs: ["core", "runtime"] }
```

Pass grants into `connectProject` and `createRuntime`. Never infer runtime permission.

- [ ] **Step 5: Run checks and commit**

```bash
pnpm exec vitest run packages/protocol/src/runtime.test.ts packages/control-plane/src/policy/authorize.test.ts packages/cli/src/runtime/createRuntime.test.ts
pnpm typecheck
git add packages/protocol/src packages/control-plane/src/policy packages/control-plane/src/help packages/cli/src
git commit -m "feat: define runtime bridge contracts"
```

### Task 2: Add one-use runtime descriptors and owned process lifecycle

**Files:**
- Create: `packages/control-plane/src/runtime/runtimeDescriptor.ts`
- Create: `packages/control-plane/src/runtime/runtimeDescriptor.test.ts`
- Create: `packages/control-plane/src/runtime/runtimeProcess.ts`
- Create: `packages/control-plane/src/runtime/runtimeProcess.test.ts`
- Create: `packages/control-plane/src/runtime/runtimeService.ts`
- Create: `packages/control-plane/src/runtime/runtimeService.test.ts`
- Modify: `packages/control-plane/src/index.ts`

**Interfaces:**
- `createRuntimeDescriptor(input): Promise<{ path; descriptor; secret: Uint8Array }>`.
- `consumeRuntimeDescriptor(path, expected): Promise<RuntimeDescriptor>`.
- `OwnedGodotProcess.launch(input): Promise<OwnedGodotProcess>` with `matchesFingerprint()`, `wait()`, and idempotent `stop()`.
- `RuntimeService.launch`, `execute`, `capture`, `snapshot`, and `close`.

- [ ] **Step 1: Write failing descriptor, fingerprint, and state-machine tests**

Cover `0600`, symlink refusal, one-use consumption, expiry, filename containment, no secret serialization in snapshots, scrubbed environment, exact fixed arguments, generation increments, single active run, stale handle, cooperative stop, verified escalation, refusal after fingerprint drift, and repeated cleanup.

- [ ] **Step 2: Run focused tests and observe missing modules**

```bash
pnpm exec vitest run packages/control-plane/src/runtime
```

Expected: FAIL because runtime lifecycle modules do not exist.

- [ ] **Step 3: Implement descriptor creation and consumption**

Create `runtime-<projectId>-<runId>.json` under `ensureRuntimeDirectory()`, write with `flag: "wx"`/mode `0o600`, validate `lstat`, rename before read, delete in `finally`, and store `secret` as base64url only in the descriptor. Public snapshots omit descriptor path, nonce, secret, and proof material.

- [ ] **Step 4: Implement owned process checks**

Launch only `godotBin` already resolved by the CLI and these fixed arguments:

```ts
["--path", project.rootRealPath,
 "--scene", "res://addons/godot_mcp/runtime/runtime_harness.tscn",
 "--remote-debug", `tcp://127.0.0.1:${debugPort}`,
 "--", `--godot-mcp-runtime-descriptor=${descriptorPath}`]
```

On macOS record `{ pid, startTime }` from `ps -o lstart= -p <pid>` immediately after spawn. Before SIGTERM/SIGKILL, re-read and compare both fields. Capture bounded stdout/stderr rings and expose no environment values.

- [ ] **Step 5: Implement the runtime finite-state machine**

Use states `idle | preparing | launching | authenticating | running | paused | stopping | stopped | failed`. Serialize lifecycle transitions, keep one `closePromise`, reject stale handles, delete unused descriptors, cancel pending requests, and route every terminal path through the same cleanup method.

- [ ] **Step 6: Run checks and commit**

```bash
pnpm exec vitest run packages/control-plane/src/runtime
pnpm typecheck
git add packages/control-plane/src/runtime packages/control-plane/src/index.ts
git commit -m "feat: own ephemeral Godot runtime lifecycle"
```

### Task 3: Add the authenticated Godot debugger bridge and harness

**Files:**
- Modify: `packages/bridge-client/src/bridgeSession.ts`
- Modify: `packages/bridge-client/src/bridgeSession.test.ts`
- Create: `addons/godot_mcp/runtime/runtime_debugger.gd`
- Create: `addons/godot_mcp/runtime/runtime_harness.gd`
- Create: `addons/godot_mcp/runtime/runtime_harness.tscn`
- Create: `addons/godot_mcp/runtime/runtime_logger.gd`
- Modify: `addons/godot_mcp/plugin.gd`
- Modify: `addons/godot_mcp/bridge/bridge_client.gd`
- Modify: `scripts/generate-godot-protocol.mjs`
- Create: `fixtures/godot-4.7/tests/runtime_harness_unit.gd`

**Interfaces:**
- Extends `BridgeSession.request` methods to `runtime.prepare | runtime.command | runtime.capture | runtime.cleanup`.
- Addon accepts preparation, binds one debugger session after keyed proof, correlates command results, and emits lifecycle notifications.
- Harness accepts only the approved operation enum through `EngineDebugger` messages prefixed `godot_mcp_runtime`.

- [ ] **Step 1: Write failing TypeScript and GDScript bridge tests**

Test runtime method correlation, preparation expiry, wrong project/session/generation, forged proof, replayed hello, duplicate sequence, command before binding, command after cleanup, and secret erasure. The GDScript unit harness must assert that unknown operations and instrumentation paths are rejected.

- [ ] **Step 2: Run tests and observe missing debugger/harness behavior**

```bash
pnpm exec vitest run packages/bridge-client/src/bridgeSession.test.ts
GODOT_BIN=/opt/homebrew/bin/godot /opt/homebrew/bin/godot --headless --path fixtures/godot-4.7 --script res://tests/runtime_harness_unit.gd
```

Expected: FAIL because runtime methods and scripts do not exist.

- [ ] **Step 3: Implement editor debugger registration and proof binding**

`runtime_debugger.gd` extends `EditorDebuggerPlugin`, returns true only for capture prefix `godot_mcp_runtime`, connects each session's `started`/`stopped` signals, verifies the canonical hello HMAC with `SessionCrypto`, binds one session, zeroes secret bytes, and emits normalized events to `plugin.gd`. `plugin.gd` registers it in `_enter_tree`, removes it in `_exit_tree`, and clears all preparations/pending calls before bridge shutdown.

- [ ] **Step 4: Implement the ephemeral harness**

Parse only the exact descriptor argument, validate the descriptor schema and expiry, delete it before hello, register one EngineDebugger capture, authenticate, load only the descriptor's `scenePath`, instantiate it as `current_scene`, and retain the instrumentation root as a sibling. Use `runtime_logger.gd` for a mutex-protected 500-record redacted ring. Unregister capture/logger and zero secrets in `_exit_tree`.

- [ ] **Step 5: Run checks and commit**

```bash
pnpm exec vitest run packages/bridge-client/src/bridgeSession.test.ts
GODOT_BIN=/opt/homebrew/bin/godot /opt/homebrew/bin/godot --headless --path fixtures/godot-4.7 --script res://tests/runtime_harness_unit.gd
pnpm typecheck
git add packages/bridge-client/src addons/godot_mcp packages/protocol scripts/generate-godot-protocol.mjs fixtures/godot-4.7/tests/runtime_harness_unit.gd
git commit -m "feat: authenticate ephemeral runtime harness"
```

### Task 4: Implement bounded runtime observation and control

**Files:**
- Create: `addons/godot_mcp/runtime/runtime_query.gd`
- Create: `addons/godot_mcp/runtime/runtime_control.gd`
- Modify: `addons/godot_mcp/runtime/runtime_harness.gd`
- Modify: `packages/control-plane/src/runtime/runtimeService.ts`
- Create: `fixtures/godot-4.7/runtime/runtime_fixture.gd`
- Create: `fixtures/godot-4.7/runtime/runtime_fixture.tscn`
- Create: `tests/integration/runtime-bridge.test.ts`

**Interfaces:**
- `RuntimeService.execute(input: RuntimeOperationInput): Promise<unknown>`.
- Runtime messages `runtime.command`/`runtime.result` carry handle, sequence, request ID, deadline, operation, and data.

- [ ] **Step 1: Add the deterministic runtime fixture and failing real-editor tests**

Fixture exposes nested nodes, groups, typed signal `milestone(value: int)`, frame and physics counters, deterministic property transitions, logs/warnings/errors, and a changing multi-color visual. Tests assert fixture truth, instrumentation exclusion, log redaction, all wait variants, pause/resume, exact step delta, timeout last-observation data, and stale generation.

- [ ] **Step 2: Run the integration test and observe unsupported operations**

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm exec vitest run tests/integration/runtime-bridge.test.ts
```

Expected: FAIL because runtime query/control adapters are absent.

- [ ] **Step 3: Implement bounded query and wait adapters**

Reuse `variant_encoder.gd`. Traverse from `current_scene`, reject absolute/subname/traversal/instrumentation paths, cap tree/node/log results, and JSON-size-check before reply. Implement the seven typed waits with `process_frame`/`physics_frame` signals and monotonic deadlines; never evaluate expressions or invoke caller-selected methods.

- [ ] **Step 4: Implement pause, resume, step, and stop**

Pause/resume use `SceneTree.paused`. Step requires paused state, temporarily enables only the instrumentation node's `PROCESS_MODE_ALWAYS`, advances the requested process frames, then confirms paused state. Stop acknowledges before `SceneTree.quit(0)`.

- [ ] **Step 5: Run checks and commit**

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm exec vitest run tests/integration/runtime-bridge.test.ts
pnpm typecheck
git add addons/godot_mcp/runtime packages/control-plane/src/runtime fixtures/godot-4.7/runtime tests/integration/runtime-bridge.test.ts
git commit -m "feat: inspect and control instrumented runtime"
```

### Task 5: Expose runtime tools and multi-frame image evidence

**Files:**
- Create: `packages/mcp-server/src/registerRuntimeTools.ts`
- Create: `packages/mcp-server/src/registerRuntimeTools.test.ts`
- Modify: `packages/mcp-server/src/createServer.ts`
- Modify: `packages/mcp-server/src/executeTool.ts`
- Modify: `packages/mcp-server/src/toolResult.ts`
- Modify: `packages/mcp-server/src/registerCoreTools.test.ts`
- Create: `addons/godot_mcp/runtime/runtime_capture.gd`
- Modify: `addons/godot_mcp/runtime/runtime_harness.gd`
- Modify: `packages/control-plane/src/runtime/runtimeService.ts`
- Modify: `packages/cli/src/runtime/createRuntime.ts`

**Interfaces:**
- `ExecutedPayload.images?: Array<{ data: Uint8Array; mimeType: "image/png" }>`.
- `registerRuntimeTools(server, dependencies)` registers only when grants authorize runtime.
- `RuntimeService.capture(input)` returns ordered verified PNG frames and metadata.

- [ ] **Step 1: Write failing tool and capture tests**

Assert default list remains six, authorized list is eight, missing tier/pack returns `PERMISSION_REQUIRED`, single capture returns one image, three-frame capture returns three ordered image blocks/evidence URIs, structured/audit output has no base64, active frames change, paused frames remain identical unless `advancePaused`, and every frame respects bounds/digest.

- [ ] **Step 2: Run focused tests and observe missing runtime registration**

```bash
pnpm exec vitest run packages/mcp-server/src/registerRuntimeTools.test.ts packages/mcp-server/src/registerCoreTools.test.ts
```

Expected: FAIL because runtime tools and image arrays do not exist.

- [ ] **Step 3: Implement runtime tool registration and ordered images**

Register both tools with closed schemas and runtime policies. Change `executeTool` and `toMcpToolResult` from one optional image to an ordered image array while preserving Phase 2 compatibility. For multi-frame capture, issue sequential single-PNG runtime requests, validate each metadata/digest pair, persist each through `EvidenceStore.putPng`, and append ordered image blocks.

- [ ] **Step 4: Implement runtime viewport capture**

Capture `get_viewport().get_texture().get_image()` after `RenderingServer.frame_post_draw`, resize within requested bounds, encode PNG, enforce 8 MiB, and reuse Phase 2 512 KiB/16-chunk delivery. Active runs wait `intervalFrames`; paused runs capture without advancing unless explicitly stepping and restoring pause.

- [ ] **Step 5: Run checks and commit**

```bash
pnpm exec vitest run packages/mcp-server/src/registerRuntimeTools.test.ts packages/mcp-server/src/registerCoreTools.test.ts
GODOT_BIN=/opt/homebrew/bin/godot pnpm exec vitest run tests/integration/runtime-bridge.test.ts
pnpm typecheck
git add packages/mcp-server/src packages/cli/src/runtime/createRuntime.ts packages/control-plane/src/runtime addons/godot_mcp/runtime
git commit -m "feat: expose runtime tools and frame evidence"
```

### Task 6: Certify hostile inputs, cleanup, and published stdio behavior

**Files:**
- Create: `tests/security/runtime-hostile.test.ts`
- Create: `tests/end-to-end/phase-3.test.ts`
- Modify: `packages/testkit/src/e2e.ts`
- Modify: `packages/testkit/src/godot.ts`
- Modify: `packages/testkit/src/index.ts`

**Interfaces:**
- Testkit launches an editor with an isolated loopback debug port and runtime-authorized MCP client.
- Failure receipts retain metadata/logs but no descriptors, secrets, or PNG bytes.

- [ ] **Step 1: Write the hostile matrix and E2E acceptance**

Cover wrong project/session, expired/forged/replayed hello, reordered commands, stale generation, traversal/subname paths, oversized tree/log/property/capture requests, deadline expiry, runtime crash, editor exit, MCP exit, fingerprint drift, repeated cleanup, tool visibility, launch/query/wait/step/capture/stop, and zero project diff.

- [ ] **Step 2: Run tests and observe any missing recovery paths**

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm exec vitest run tests/security/runtime-hostile.test.ts tests/end-to-end/phase-3.test.ts
```

Expected: initial FAIL identifies incomplete failure-path or testkit behavior.

- [ ] **Step 3: Implement only the recovery/testkit gaps shown by failures**

Keep production changes scoped to owned-process reconciliation, secret/path redaction, request cancellation, and debugger cleanup. Testkit must allocate a free loopback port, pass `--debug-server tcp://127.0.0.1:<port>` to the disposable editor, and never expose descriptors in failure output.

- [ ] **Step 4: Run checks and commit**

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm exec vitest run tests/security/runtime-hostile.test.ts tests/end-to-end/phase-3.test.ts
pnpm typecheck
git add tests/security/runtime-hostile.test.ts tests/end-to-end/phase-3.test.ts packages/testkit packages/control-plane packages/cli addons/godot_mcp
git commit -m "test: certify runtime security and cleanup"
```

### Task 7: Add the Phase 3 gate and documentation

**Files:**
- Create: `scripts/qa-phase-3.mjs`
- Create: `docs/testing/phase-3.md`
- Modify: `package.json`
- Modify: `docs/protocol/bridge-v1.md`
- Modify: `docs/security/threat-model.md`
- Modify: `README.md`
- Modify: `AGENTS.md`

**Interfaces:**
- `pnpm qa:phase-3` runs the 15 ordered certification stages from the approved design.

- [ ] **Step 1: Add a failing gate metadata test**

Extend `tests/meta/workspace.test.ts` to require `qa:phase-3`, the exact Godot version check, ordered runtime integration/security/E2E stages, failure-only artifact handling, and updated current-plan links.

- [ ] **Step 2: Run the metadata test and observe missing gate/docs**

```bash
pnpm exec vitest run tests/meta/workspace.test.ts
```

Expected: FAIL because Phase 3 gate and documentation do not exist.

- [ ] **Step 3: Implement gate and documentation**

Model `qa-phase-3.mjs` after Phase 2, keep commands argument-array based, require exact `4.7.stable.official.5b4e0cb0f`, retain only redacted failure artifacts, and finish with `git diff --check`. Document the eight-tool authorized surface, default six-tool surface, explicit flags, bounds, cleanup, limitations, and certification evidence.

- [ ] **Step 4: Run checks and commit**

```bash
pnpm exec vitest run tests/meta/workspace.test.ts
pnpm lint
pnpm typecheck
git diff --check
git add scripts/qa-phase-3.mjs docs package.json README.md AGENTS.md tests/meta/workspace.test.ts
git commit -m "docs: add Phase 3 certification gate"
```

### Task 8: Run authoritative certification and close review findings

**Files:**
- Modify only files required by observed failures or actionable review findings.

**Interfaces:**
- Produces passing Phase 3 and Phase 0-2 regression receipts with a clean worktree.

- [ ] **Step 1: Run the authoritative Phase 3 gate**

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-3
```

Expected: PASS all ordered stages. If a stage fails, preserve its failure artifacts, fix only the observed cause, rerun the failed focused stage, then rerun the full gate because the diff changed.

- [ ] **Step 2: Run both earlier regression gates**

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-0-1
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-2
```

Expected: PASS both gates.

- [ ] **Step 3: Perform a pre-ship code review**

Review authorization, descriptor secrecy, runtime message validation, PID fingerprinting, project containment, redaction, stale handles, capture bounds, cleanup idempotency, and roadmap boundaries. Resolve every actionable finding and rerun affected focused tests plus all three gates.

- [ ] **Step 4: Commit review fixes if any**

```bash
git add packages addons fixtures tests scripts docs README.md AGENTS.md package.json
git commit -m "fix: close Phase 3 review findings"
```

Skip this commit when review finds no required changes.

- [ ] **Step 5: Record final state**

```bash
git status --short --branch
git log --oneline -10
```

Expected: clean `main`, Phase 3 commits present, no runtime descriptor, no owned fixture process, and no untracked failure artifact containing secrets or PNG bytes.
