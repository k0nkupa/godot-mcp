# Phase 4 Input Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add permission-scoped, bounded input injection, frame-indexed sequences, non-passive recording, deterministic replay, coordinate transforms, and input receipts to the authenticated Phase 3 runtime.

**Architecture:** Add one `godot_input` MCP tool behind the existing `runtime_control` tier and the separate `input` capability pack. The control plane validates a closed input-event union and serializes input with all other operations on the owned runtime; the authenticated runtime harness constructs only approved `InputEvent` subclasses, routes non-positional input through `Input.parse_input_event()`, routes positional input through an explicitly resolved `Viewport.push_input()`, and shares a frame clock with pause/step control. Recording captures only successfully injected MCP events, while deterministic replay requires a paused runtime and advances exact frames without observing or storing ambient OS input.

**Tech Stack:** Node.js 22; pnpm 11.13.0; TypeScript 6.0.3; Zod 4.4.3; MCP TypeScript SDK 1.29.0; Vitest 4.1.10; Godot `4.7.stable.official.5b4e0cb0f`; GDScript.

## Global Constraints

- Preserve MCP over stdio, the editor bridge on `127.0.0.1`, the outbound-connecting addon, and the listener-free child runtime.
- Preserve the Phase 3 one-use runtime descriptor, mutual debugger proof, run handle generation, signed bridge envelopes, strict sequences, deadlines, process fingerprinting, owner lease, audit redaction, and idempotent cleanup.
- Default sessions continue to expose exactly six observe-only tools. `godot_input` appears only when both `runtime_control` and `input` are explicit; launching the owned runtime still requires the separate `runtime` pack.
- Input automation applies only to the authenticated MCP-owned runtime. It never sends OS-global events, controls the editor, or targets an unowned process.
- Do not expose `Viewport.push_text_input()`, arbitrary `InputEvent` class names, unvalidated resource construction, generic property assignment, arbitrary method invocation, GDScript evaluation, shell, filesystem, network, or process primitives.
- Recording is non-passive: it records only events successfully injected through `godot_input`. It never captures ambient hardware input or arbitrary text.
- Event batches contain at most 256 events, traces encode at most 256 events and 256 KiB of canonical JSON, frame offsets are nondecreasing integers from 0 through 1,800, and an input command deadline is at most 30 seconds.
- Pointer coordinates are finite. Normalized coordinates are in `[0, 1]`; viewport/embedder coordinates are in `[-8192, 8192]`. Touch indices are 0–9, gamepad devices are 0–7, and all strengths/pressures are bounded by the corresponding Godot 4.7 range.
- Action names must already exist in `InputMap`. Non-positional action/key/gamepad events target the root runtime and use `Input.parse_input_event()`; positional pointer/touch/gesture events resolve only `.` or a relative descendant `Viewport` and use `Viewport.push_input()` exactly once.
- Mouse drag is represented explicitly as an ordered mouse-button/mouse-motion sequence; touch drag uses `touch_drag`. Pan and magnify are the only gesture subclasses in Phase 4.
- Deterministic execution requires the runtime to be paused before the call, advances exact rendered frames, and leaves it paused. Realtime execution requires an unpaused runtime and is explicitly marked `deterministic: false` in the receipt.
- Every terminal path—success, invalid event, timeout, cancellation, scene replacement, runtime stop, debugger loss, editor disconnect, or server crash—releases MCP-held actions, keys, buttons, touches, and nonzero joy axes when the harness remains reachable.
- Use only disposable copies of `fixtures/godot-4.7` for runtime, destructive, hostile-input, and end-to-end checks. No Phase 4 test mutates a real game checkout.
- A Phase 4 completion claim requires `GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-4`, followed by the Phase 0–1, Phase 2, and Phase 3 regression gates.

---

### Task 1: Define the closed Phase 4 input protocol and public capability

**Files:**
- Create: `packages/protocol/src/input.ts`
- Create: `packages/protocol/src/input.test.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/control-plane/src/policy/capabilities.ts`
- Modify: `packages/control-plane/src/policy/authorize.test.ts`
- Modify: `packages/control-plane/src/help/coreHelp.ts`
- Modify: `packages/control-plane/src/help/coreHelp.test.ts`
- Modify: `packages/protocol/product.json`

**Interfaces:**
- `InputEventSchema` is a strict discriminated union for `action`, `key`, `mouse_button`, `mouse_motion`, `scroll`, `touch`, `touch_drag`, `pan_gesture`, `magnify_gesture`, `joypad_button`, and `joypad_motion`.
- `InputOperationInputSchema` is a strict union for `send`, `sequence`, `record_start`, `record_stop`, and `replay`.
- `InputTraceSchema` is `{ schemaVersion: 1; events: InputTraceEvent[] }`, where every trace event contains a nondecreasing `frameOffset` and an `InputEvent`.
- `InputReceiptSchema` contains no caller text or raw event payloads; it reports handle, operation, event kinds/count, requested and delivered frame offsets, coordinate-space metadata, releases, deterministic status, and canonical trace SHA-256. `InputOperationResultSchema` wraps the receipt and carries a trace only for `record_stop`.
- `INPUT_POLICY` is `{ command: "godot_input", tier: "runtime_control", pack: "input", mutating: true }`.

- [ ] **Step 1: Write failing protocol tests for every supported event and operation**

Use one valid case per event kind, simultaneous touch indices, same-frame sequence events, a deterministic replay trace, and defaults for root viewport, viewport coordinate space, realtime sequence mode, and 10-second timeout. Assert rejection of unknown keys, nonexistent operation variants, text payloads, NaN/infinity, out-of-range normalized coordinates, traversal/subname viewport paths, decreasing trace offsets, more than 256 events, offsets over 1,800, more than ten active touch indices in one sequence, invalid strengths, and traces over 256 KiB canonical JSON.

```ts
const trace = {
  schemaVersion: 1 as const,
  events: [
    { frameOffset: 0, event: { type: "action", action: "jump", pressed: true, strength: 1 } },
    { frameOffset: 1, event: { type: "action", action: "jump", pressed: false, strength: 0 } },
  ],
};
expect(InputOperationInputSchema.parse({ operation: "replay", handle, trace })).toMatchObject({
  operation: "replay",
  mode: "deterministic",
});
```

- [ ] **Step 2: Run the protocol test and verify the missing contract**

```bash
pnpm exec vitest run packages/protocol/src/input.test.ts
```

Expected: FAIL because `packages/protocol/src/input.ts` and its exports do not exist.

- [ ] **Step 3: Implement exact schemas and exported types**

Use reusable strict schemas for `Vector2`, modifiers, coordinate target, runtime handle, and trace steps. Keep public key/joy constants numeric and bounded; do not accept engine class names or arbitrary dictionaries.

```ts
export const InputOperationInputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("send"), handle: RuntimeHandleSchema, event: InputEventSchema }).strict(),
  z.object({
    operation: z.literal("sequence"), handle: RuntimeHandleSchema,
    mode: z.enum(["realtime", "deterministic"]).default("realtime"),
    timeoutMs: z.number().int().min(1).max(30_000).default(10_000),
    events: z.array(InputTraceEventSchema).min(1).max(256),
  }).strict(),
  z.object({ operation: z.literal("record_start"), handle: RuntimeHandleSchema }).strict(),
  z.object({ operation: z.literal("record_stop"), handle: RuntimeHandleSchema }).strict(),
  z.object({
    operation: z.literal("replay"), handle: RuntimeHandleSchema,
    mode: z.literal("deterministic").default("deterministic"),
    timeoutMs: z.number().int().min(1).max(30_000).default(10_000),
    trace: InputTraceSchema,
  }).strict(),
]);
```

- [ ] **Step 4: Add the policy, capability visibility, product metadata, and focused help topic**

Add `INPUT_POLICY` to a new `INPUT_POLICIES` collection and include it in `visibleCapabilities()`. Extend `CoreHelpTopic` with `input`, describing injection and non-passive recording without implying OS-global or editor input. Assert core-only, runtime-only, input-only, and runtime-plus-input tool visibility independently.

- [ ] **Step 5: Run focused checks and commit**

```bash
pnpm exec vitest run packages/protocol/src/input.test.ts packages/control-plane/src/policy packages/control-plane/src/help
pnpm typecheck
git add packages/protocol/src/input.ts packages/protocol/src/input.test.ts packages/protocol/src/index.ts packages/protocol/product.json packages/control-plane/src/policy packages/control-plane/src/help
git commit -m "feat: define bounded runtime input contracts"
```

### Task 2: Serialize input through the owned runtime and protect audit detail

**Files:**
- Create: `packages/control-plane/src/runtime/inputReceipt.ts`
- Create: `packages/control-plane/src/runtime/inputReceipt.test.ts`
- Modify: `packages/control-plane/src/runtime/runtimeService.ts`
- Modify: `packages/control-plane/src/runtime/runtimeService.test.ts`
- Modify: `packages/control-plane/src/index.ts`
- Modify: `packages/mcp-server/src/executeTool.ts`
- Modify: `packages/mcp-server/src/executeTool.test.ts`

**Interfaces:**
- `RuntimeService.input(input: InputOperationInput): Promise<InputOperationResult>` uses the same `operationTail` as launch, observation, pause/step, capture, stop, disconnect, and close.
- `summarizeInputForAudit(input)` returns handle, operation, mode, event count, event-kind counts, frame range, and trace digest only.
- `executeTool(..., options?: { auditArguments?: unknown })` preserves existing behavior when omitted and writes the supplied summary when present.

- [ ] **Step 1: Write failing serialization and audit tests**

Prove that input cannot overtake capture, pause, scene change, stop, disconnect, or another input command; stale handles fail before bridge dispatch; runtime state preconditions are enforced; a 30-second public timeout gets only the existing 1-second transport margin; and an input request containing action/key/coordinate detail writes only the summary and digest to audit JSONL.

- [ ] **Step 2: Run focused tests and observe missing methods**

```bash
pnpm exec vitest run packages/control-plane/src/runtime packages/mcp-server/src/executeTool.test.ts
```

Expected: FAIL because `RuntimeService.input`, receipt validation, and audit-argument override do not exist.

- [ ] **Step 3: Add canonical receipt hashing and audit summarization**

Use `canonicalJson()` and SHA-256 over `{ schemaVersion: 1, events }`. Never hash or serialize runtime descriptor material. Validate the Godot result with `InputReceiptSchema` before returning it.

```ts
export function traceSha256(trace: InputTrace): string {
  return createHash("sha256").update(canonicalJson(trace)).digest("hex");
}

export function summarizeInputForAudit(input: InputOperationInput): InputAuditSummary {
  const events = input.operation === "send" ? [{ frameOffset: 0, event: input.event }]
    : input.operation === "sequence" ? input.events
    : input.operation === "replay" ? input.trace.events : [];
  return summarizeKindsAndFrames(input.handle, input.operation, events);
}
```

- [ ] **Step 4: Add `RuntimeService.input()` on the existing exclusive queue**

Call `assertHandle`, forward only `{ operation: "input", handle, input }`, apply the bounded timeout, and reject a receipt whose handle, event count, deterministic flag, or trace digest does not match the request. Do not create a second queue or independent runtime controller.

- [ ] **Step 5: Add optional audit arguments without changing other tools**

Keep the original tool arguments as the default. The later `godot_input` registration passes `summarizeInputForAudit(input)`; all existing tests must prove unchanged audit records for current tools.

- [ ] **Step 6: Run focused checks and commit**

```bash
pnpm exec vitest run packages/control-plane/src/runtime packages/mcp-server/src/executeTool.test.ts
pnpm typecheck
git add packages/control-plane/src/runtime packages/control-plane/src/index.ts packages/mcp-server/src/executeTool.ts packages/mcp-server/src/executeTool.test.ts
git commit -m "feat: serialize runtime input and redact receipts"
```

### Task 3: Build approved Godot input events and viewport transforms

**Files:**
- Create: `addons/godot_mcp/runtime/runtime_input_event_factory.gd`
- Create: `addons/godot_mcp/runtime/runtime_input_coordinates.gd`
- Create: `addons/godot_mcp/runtime/runtime_input_state.gd`
- Create: `fixtures/godot-4.7/tests/runtime_input_unit.gd`
- Modify: `fixtures/godot-4.7/project.godot`

**Interfaces:**
- `GodotMcpRuntimeInputEventFactory.build(spec: Dictionary) -> Dictionary` returns `{ ok, event, route, stateKey }` or a stable bounded error.
- `GodotMcpRuntimeInputCoordinates.resolve(root, target, position) -> Dictionary` resolves only `.` or a relative descendant `Viewport` and returns the transformed event, `inLocalCoords`, target viewport, visible size, and receipt metadata.
- `GodotMcpRuntimeInputState.observe(eventSpec)` tracks only MCP-held state; `release_all()` constructs bounded release/neutral events for every held state.

- [ ] **Step 1: Write failing GDScript unit coverage**

Cover all approved `InputEvent` subclasses, modifiers, action existence, key/joy bounds, wheel conversion into matched press/release events, ten-finger touch state, drag pressure, pan delta, magnify factor, root viewport coordinates, normalized coordinates, embedder-to-SubViewport conversion, stretch transforms, target-not-viewport rejection, relative-path containment, and release generation for every stateful event.

- [ ] **Step 2: Run the Godot unit and verify missing adapters**

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm build
tmpdir="$(mktemp -d)"
cp -R fixtures/godot-4.7 "$tmpdir/project"
node packages/cli/dist/bin.js init --project "$tmpdir/project"
/opt/homebrew/bin/godot --headless --path "$tmpdir/project" --script res://tests/runtime_input_unit.gd
rm -rf "$tmpdir"
```

Expected: nonzero exit because the three runtime input adapters are absent.

- [ ] **Step 3: Implement the explicit event factory**

Instantiate only named classes in the closed match. Reject `push_text_input`, unknown actions, invalid enum values, caller-chosen classes, and extra fields a second time inside Godot. Convert a `scroll` specification into bounded wheel button press/release pairs rather than fabricating an unsupported event type.

```gdscript
match String(spec.get("type", "")):
	"action": return _action(spec)
	"key": return _key(spec)
	"mouse_button": return _mouse_button(spec)
	"mouse_motion": return _mouse_motion(spec)
	"scroll": return _scroll(spec)
	"touch": return _touch(spec)
	"touch_drag": return _touch_drag(spec)
	"pan_gesture": return _pan(spec)
	"magnify_gesture": return _magnify(spec)
	"joypad_button": return _joypad_button(spec)
	"joypad_motion": return _joypad_motion(spec)
	_: return _error("INVALID_REQUEST", "Input event type is not allowed")
```

- [ ] **Step 4: Implement viewport routing and receipt metadata**

Use `Viewport.push_input(event, true)` for viewport/normalized coordinates and `Viewport.push_input(event, false)` for embedder coordinates so Godot performs the embedder conversion. Root `.` resolves to `_root.get_viewport()`; any other target must resolve from the current game-scene root, contain no traversal/subname, and be a `Viewport`. Return requested space, target relative path, visible size, and stretch-transform metadata without host window coordinates; assert the received local coordinate through the fixture rather than claiming `push_input()` mutates the caller's event object.

- [ ] **Step 5: Implement held-state tracking and bounded neutralization**

Track actions by action name, keys by device/keycode, mouse buttons by device/button, touch by index, joy buttons by device/button, and nonzero axes by device/axis. Releases use the same route and latest safe position where applicable; joy axes return to `0.0`. Clear state only after release dispatch.

- [ ] **Step 6: Run the GDScript unit, addon lifecycle regression, and commit**

```bash
pnpm exec vitest run tests/integration/addon-lifecycle.test.ts
pnpm typecheck
git add addons/godot_mcp/runtime/runtime_input_event_factory.gd addons/godot_mcp/runtime/runtime_input_coordinates.gd addons/godot_mcp/runtime/runtime_input_state.gd fixtures/godot-4.7/tests/runtime_input_unit.gd fixtures/godot-4.7/project.godot
git commit -m "feat: construct bounded Godot input events"
```

### Task 4: Execute sequences, recording, and deterministic replay in the harness

**Files:**
- Create: `addons/godot_mcp/runtime/runtime_frame_clock.gd`
- Create: `addons/godot_mcp/runtime/runtime_input.gd`
- Create: `addons/godot_mcp/runtime/runtime_input_trace.gd`
- Modify: `addons/godot_mcp/runtime/runtime_control.gd`
- Modify: `addons/godot_mcp/runtime/runtime_harness.gd`
- Modify: `fixtures/godot-4.7/tests/runtime_harness_unit.gd`
- Modify: `fixtures/godot-4.7/tests/runtime_input_unit.gd`

**Interfaces:**
- `GodotMcpRuntimeFrameClock.advance_paused(frames, deadline) -> Dictionary` is shared by runtime `step` and deterministic input.
- `GodotMcpRuntimeInput.execute(input, deadline) -> Dictionary` handles the five public operations and returns a validated receipt-shaped dictionary.
- `GodotMcpRuntimeInput.release_all(reason) -> Dictionary` is idempotent and safe during scene teardown.
- `GodotMcpRuntimeInputTrace` stores at most 256 successfully delivered MCP events relative to the first delivered process frame.

- [ ] **Step 1: Extend failing harness tests for ordering and cleanup**

Assert same-frame ordering, nondecreasing offsets, realtime scheduling against process frames, deterministic paused execution, exact frame advancement, pause-state restoration, record start/conflict/stop behavior, replay digest parity, trace overflow refusal before partial delivery, timeout receipt with exact delivered count, scene-change cancellation, and idempotent release on stop/exit.

- [ ] **Step 2: Extract the proven Phase 3 frame-step loop**

Move the deadline-aware unpause/process-frame/post-draw/repause logic from `runtime_control.gd` into `runtime_frame_clock.gd`. Keep `runtime_control.step` behavior and tests byte-for-byte equivalent at the public contract.

- [ ] **Step 3: Implement exact routing semantics**

Use `Input.parse_input_event()` only for action, key, and joy events. Use the resolved `Viewport.push_input()` only for mouse, touch, and gesture events. Never double-dispatch. For deterministic batches, dispatch every event at an offset before advancing the corresponding frame; for realtime batches, await process frames without changing pause state. Check deadline, scene revision, and handle validity before each dispatch.

- [ ] **Step 4: Implement non-passive recording and replay**

`record_start` resets a per-run trace and rejects a second active recording. Successful `send` and `sequence` deliveries append normalized specs; failed pre-dispatch events append nothing. `record_stop` returns and clears the trace. `replay` accepts only the bounded v1 trace and executes it through the same deterministic path; no `_input` hook records ambient events.

- [ ] **Step 5: Wire lifecycle cleanup into the harness**

Instantiate input only after the authenticated game scene is bound. Add `input` to the exact operation allowlist. On scene invalidation, runtime cleanup, cooperative stop, and `_exit_tree`, call `release_all()` before clearing the adapter when possible. Cancel pending input when `_scene_revision` changes and return `TARGET_NOT_FOUND` with delivered-count metadata rather than continuing in the replacement scene.

- [ ] **Step 6: Run Godot/runtime regressions and commit**

```bash
pnpm exec vitest run packages/control-plane/src/runtime tests/integration/runtime-bridge.test.ts
pnpm typecheck
git add addons/godot_mcp/runtime/runtime_frame_clock.gd addons/godot_mcp/runtime/runtime_input.gd addons/godot_mcp/runtime/runtime_input_trace.gd addons/godot_mcp/runtime/runtime_control.gd addons/godot_mcp/runtime/runtime_harness.gd fixtures/godot-4.7/tests/runtime_harness_unit.gd fixtures/godot-4.7/tests/runtime_input_unit.gd
git commit -m "feat: execute deterministic runtime input traces"
```

### Task 5: Expose one input-pack MCP tool with bounded receipts

**Files:**
- Create: `packages/mcp-server/src/registerInputTools.ts`
- Create: `packages/mcp-server/src/registerInputTools.test.ts`
- Modify: `packages/mcp-server/src/createServer.ts`
- Modify: `packages/mcp-server/src/index.ts`
- Modify: `packages/cli/src/commands/connect.ts`
- Modify: `packages/cli/src/commands/connect.test.ts`
- Modify: `packages/control-plane/src/help/coreHelp.ts`

**Interfaces:**
- `InputController.input(input: InputOperationInput): Promise<InputOperationResult>`.
- `registerInputTools(server, dependencies)` registers only `godot_input`.
- `createGodotMcpServer` registers input tools only when policy visibility contains `INPUT_POLICY`.

- [ ] **Step 1: Write failing MCP visibility, annotation, receipt, and audit tests**

Assert exactly six tools for core-only; eight for runtime-only; seven for input-only; and nine for core+runtime+input. Assert `godot_input` annotations are `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`, and `openWorldHint: false`. Call each operation, validate structured receipts, and prove raw events/action names/keycodes/coordinates are absent from JSONL audit while the event-kind counts and digest remain.

- [ ] **Step 2: Run the focused MCP test and verify the tool is absent**

```bash
pnpm exec vitest run packages/mcp-server/src/registerInputTools.test.ts packages/cli/src/commands/connect.test.ts
```

Expected: FAIL because `godot_input` is not registered.

- [ ] **Step 3: Register `godot_input` through policy and the runtime service**

Validate with `InputOperationInputSchema`, authorize with `INPUT_POLICY`, call `runtime.input(input)`, and pass the audit summary through the Task 2 override. Do not add a second input tool, an editor input path, or dynamic per-event tools.

- [ ] **Step 4: Preserve explicit CLI grants**

Keep `--grant runtime_control --pack input` explicit and independent from `--pack runtime`. Help text must explain that `input` exposes automation but a runtime must already be launched through the separately granted runtime pack.

- [ ] **Step 5: Run focused checks and commit**

```bash
pnpm exec vitest run packages/mcp-server/src/registerInputTools.test.ts packages/mcp-server/src/registerRuntimeTools.test.ts packages/cli/src/commands/connect.test.ts
pnpm lint
pnpm typecheck
git add packages/mcp-server/src packages/cli/src/commands/connect.ts packages/cli/src/commands/connect.test.ts packages/control-plane/src/help/coreHelp.ts
git commit -m "feat: expose permission-scoped runtime input"
```

### Task 6: Add a truth-rich input fixture and real-runtime integration coverage

**Files:**
- Create: `fixtures/godot-4.7/input/input_fixture.gd`
- Create: `fixtures/godot-4.7/input/input_fixture.tscn`
- Create: `fixtures/godot-4.7/input/embedded_input_receiver.gd`
- Create: `tests/integration/runtime-input.test.ts`
- Modify: `fixtures/godot-4.7/project.godot`
- Modify: `packages/testkit/src/index.ts`

**Interfaces:**
- The fixture exposes bounded observable state for action presses/releases, keycode, mouse position/buttons/motion/scroll, active touches and drags, pan/magnify, joy buttons/axes, delivery order, and a state digest.
- A stretched root viewport and an embedded `SubViewport` expose distinct asserted coordinate results.

- [ ] **Step 1: Build the fixture around asserted state, not log-only output**

Add the `phase_4_accept` action to `project.godot`. The fixture updates exported primitive fields that Phase 3 `node` and `wait` operations can inspect. Include two simultaneous touches, a draggable `Control`, a stretched root target, and an embedded `SubViewportContainer` target whose receiver records local coordinates.

- [ ] **Step 2: Write failing real-runtime integration tests**

Launch a disposable imported fixture through the real editor/debugger bridge. Exercise every event kind, root and embedded coordinate modes, a realtime sequence, deterministic sequence, recording, replay, and cleanup. Assert state through `RuntimeService.execute({ operation: "node" | "wait" })`; do not use fixture logs as the only oracle.

- [ ] **Step 3: Prove deterministic replay with pinned preconditions**

For two fresh runs, pin fixture revision, viewport size, renderer, locale, seed, and paused start. Replay the same returned trace, then compare the fixture's state digest, delivered event order, process-frame delta, and final pause state. The test must fail if one frame offset or coordinate changes.

- [ ] **Step 4: Prove cleanup of held states**

Hold an action, key, mouse button, touch, joy button, and nonzero joy axis; trigger normal stop, scene replacement, deadline expiry, debugger disconnect, and server close in separate cases; assert release/neutral state when reachable and no owned process/runtime descriptor/lease remains otherwise.

- [ ] **Step 5: Run integration checks and commit**

```bash
pnpm exec vitest run tests/integration/runtime-input.test.ts tests/integration/runtime-bridge.test.ts
pnpm typecheck
git add fixtures/godot-4.7/input fixtures/godot-4.7/project.godot tests/integration/runtime-input.test.ts packages/testkit/src/index.ts
git commit -m "test: verify real runtime input automation"
```

### Task 7: Certify hostile input and published stdio behavior

**Files:**
- Create: `tests/security/input-hostile.test.ts`
- Create: `tests/end-to-end/phase-4.test.ts`
- Modify: `tests/security/runtime-hostile.test.ts`
- Modify: `packages/bridge-client/src/bridgeSession.test.ts`

**Interfaces:**
- Published E2E uses `connect --grant runtime_control --pack runtime --pack input` and only the nine expected tools.
- Failure artifacts contain redacted audit, editor output, MCP stderr, and the last structured receipt; they never contain runtime descriptors, proof material, trace payloads, raw key/action detail, or host window coordinates.

- [ ] **Step 1: Add schema, authorization, payload, and deadline attacks**

Cover unknown event classes, extra properties, huge arrays, oversized canonical trace, nonfinite numbers, invalid enum integers, invalid action names, traversal/subname viewport targets, nonexistent/non-Viewport targets, touch-index abuse, decreasing offsets, stale handles, replayed debugger sequences, expired deadlines, late results, scene-revision changes, and requests without both required grants.

- [ ] **Step 2: Add published stdio Phase 4 acceptance**

Through a built CLI/MCP stdio process, verify the exact tool list, launch the input fixture, inject one asserted event from each family, run and record a deterministic sequence, replay it in a fresh owned run, compare state digests, stop, disable, uninstall, and prove `project.diffFromOriginal()` and runtime-directory listings are empty.

- [ ] **Step 3: Add crash and redaction assertions**

Hard-stop the MCP owner during a held-input sequence and verify lease-driven child exit. Force an E2E failure after a key/action sequence, preserve failure artifacts, and assert that descriptors, 43-character secret-like values, raw trace JSON, action names, and keycodes are absent.

- [ ] **Step 4: Run hostile and E2E checks and commit**

```bash
pnpm exec vitest run tests/security/input-hostile.test.ts tests/security/runtime-hostile.test.ts packages/bridge-client/src/bridgeSession.test.ts
GODOT_BIN=/opt/homebrew/bin/godot pnpm exec vitest run tests/end-to-end/phase-4.test.ts
git add tests/security/input-hostile.test.ts tests/security/runtime-hostile.test.ts tests/end-to-end/phase-4.test.ts packages/bridge-client/src/bridgeSession.test.ts
git commit -m "test: certify Phase 4 input boundaries"
```

### Task 8: Add the Phase 4 gate and operator documentation

**Files:**
- Create: `scripts/qa-phase-4.mjs`
- Create: `docs/testing/phase-4.md`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/security/threat-model.md`
- Modify: `docs/protocol/bridge-v1.md`
- Modify: `AGENTS.md`

**Interfaces:**
- `pnpm qa:phase-4` resolves `GODOT_BIN`, requires exact Godot `4.7.stable.official.5b4e0cb0f`, runs the complete Phase 4 gate, and preserves failure-only redacted artifacts.
- `docs/testing/phase-4.md` is the source of truth for scope, commands, pinned conditions, expected tool surface, deterministic replay evidence, cleanup proof, and known boundaries.

- [ ] **Step 1: Write the gate as an ordered certification program**

Run generated-protocol drift, build, lint, typecheck, package tests, disposable fixture import, GDScript input units, runtime contract units, authenticated input integration, MCP tool/audit tests, hostile input matrix, cleanup/release recovery, published stdio Phase 4 E2E, full `pnpm test`, and both branch/working-tree `git diff --check`. Copy failure evidence before fixture cleanup and delete it only after a full pass.

- [ ] **Step 2: Document the exact security and protocol extension**

Update the threat model title to Phase 0–4. Document that input is owned-runtime-only, `input`-pack gated, closed-union, bounded, non-passively recorded, summarized in audit, cleaned up on terminal paths, and incapable of OS-global input or arbitrary text injection. Add the `runtime.command` operation `input` and receipt/trace rules to bridge v1 without credential-shaped examples.

- [ ] **Step 3: Document operator usage and deterministic conditions**

Show the required grant combination, a safe action sequence, record/replay workflow, root versus embedded viewport coordinates, receipt fields, and recovery actions. State that realtime receipts are non-deterministic and deterministic replay requires a paused owned runtime with pinned project revision, Godot version, viewport, renderer, locale, seed, and time step.

- [ ] **Step 4: Run the complete new gate and commit**

```bash
GODOT_BIN=/opt/homebrew/bin/godot node scripts/qa-phase-4.mjs
git diff --check
git add scripts/qa-phase-4.mjs docs/testing/phase-4.md package.json README.md docs/security/threat-model.md docs/protocol/bridge-v1.md AGENTS.md
git commit -m "docs: add Phase 4 input certification gate"
```

### Task 9: Run authoritative certification and close review findings

**Files:**
- Modify only files required by observed certification or review failures.

**Interfaces:**
- The final branch has a clean worktree, no leaked fixture/runtime artifacts, no weakened Phase 0–3 invariant, and a reproducible Phase 4 gate receipt.

- [ ] **Step 1: Run the authoritative Phase 4 gate**

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-4
```

Expected: PASS with every documented stage; no stage may be skipped or described as passed if it did not run.

- [ ] **Step 2: Run prior-phase regression gates**

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-0-1
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-2
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-3
```

Expected: all three gates PASS without changing their tool-count or security assertions.

- [ ] **Step 3: Review the completed diff against the master design and threat model**

Confirm every Phase 4 bullet and gate has direct test evidence; the input pack is independent; default sessions still expose six tools; no ambient recording, text injection, editor input, arbitrary class/method, host I/O, or listener was introduced; all held-state terminal paths are covered; and fixture pre/post diffs are empty.

- [ ] **Step 4: Fix only evidence-backed findings and rerun affected checks**

For each failure, first add or tighten the smallest reproducing test, implement the narrow correction, rerun the focused test, then rerun any authoritative gate invalidated by the diff. Do not refactor unrelated Phase 0–3 code during closeout.

- [ ] **Step 5: Record the final certification commit**

```bash
git status --short
git diff --check
git add -u
git commit -m "test: certify Phase 4 input automation"
```

Expected: task-owned paths are clean after the commit, unrelated user changes remain untouched, and the handoff records the exact gate outputs and any intentionally skipped platform lanes.
