# Phase 7 Debugging and Performance Implementation Plan

> **Execution mode:** inline in the primary task. No subagents.

**Goal:** Add bounded authenticated GDScript debugging and performance evidence without expanding the Phase 0–6 authority boundary.

**Architecture:** Extend `godot_runtime`. Launch the editor through the CLI with authenticated debugger and native DAP assigned one port so DAP never wins a startup bind, then stop the inactive DAP plugin and fail closed on ordinary launches. Route breakpoints and execution control through the uniquely authenticated `EditorDebuggerSession`; route bounded stack/variable capture and profiler work through the existing signed runtime command channel. Bind every opaque reference to runtime, debugger, and stop identity.

**Gate rule:** Phase 8 may start only after the full Phase 7 gate, Phase 0–6 regression gates, and branch autoreview are green.

## Guardrails

- MCP remains on stdio.
- Bridge/debug listeners remain loopback-only; loopback is not authentication.
- Native Godot DAP must be disabled before runtime preparation succeeds.
- No raw debugger passthrough, evaluate, method call, variable mutation, launch, restart, or terminate.
- Breakpoints are project-local GDScript only and exclude the addon.
- Stack/variable evidence is bounded, secret-redacted, stop-bound, and released before continue.
- Performance evidence is bounded and uses shared canonical wire encoding for its digest.
- All mutation-capable editor/runtime tests use disposable fixture copies.

## Implementation map

```text
packages/protocol/src/runtimeDebug.ts                   Phase 7 debug schemas
packages/protocol/src/runtimePerformance.ts             monitor/profile schemas
packages/control-plane/src/runtime/debuggerClient.ts    closed internal command types
packages/control-plane/src/runtime/debugTokenStore.ts   opaque stop-bound references
packages/control-plane/src/runtime/runtimeService.ts    debugger/profile lifecycle
addons/godot_mcp/plugin.gd                              secure-launch proof and native-DAP shutdown
packages/cli/src/commands/editor.ts                     certified shared-port editor launcher
addons/godot_mcp/runtime/runtime_debugger.gd            authenticated editor-session adapter
addons/godot_mcp/runtime/runtime_debug_capture.gd       bounded ScriptBacktrace projection
addons/godot_mcp/runtime/runtime_harness.gd             signed debug/performance routing
addons/godot_mcp/runtime/runtime_profiler.gd            public monitor/profile evidence
tests/integration/runtime-debugging.test.ts              real authenticated debugger proof
tests/integration/runtime-performance.test.ts            real profiler proof
tests/security/runtime-debugging-hostile.test.ts         auth/path/token/bound attacks
tests/end-to-end/phase-7.test.ts                         published stdio proof
scripts/qa-phase-7.mjs                                  ordered certification gate
```

## Task 1: Define the public Phase 7 contract

- Add strict discriminated debug and performance operation schemas.
- Preserve the unchanged `godot_runtime` tool count and grant/pack policy.
- Bound breakpoint counts/files/lines, waits, frames, variable pages/depth/total, selectors, profile duration/cadence/groups/samples/bytes.
- Add protocol tests and generated-contract drift checks.

Validation:

```bash
pnpm exec vitest run packages/protocol/src/runtimeDebug.test.ts packages/protocol/src/runtimePerformance.test.ts
node scripts/generate-godot-protocol.mjs --check
```

## Task 2: Implement opaque debugger state and authenticated command types

- Add 256-bit frame/variable tokens.
- Bind tokens to run ID, runtime generation, authenticated debugger generation, and stop sequence.
- Clear tokens on execution transitions, new stops, reconnect, stop, crash, disconnect, and cleanup.
- Expose only the fixed internal debugger commands required by Phase 7.
- Do not ship a TCP DAP client or framing parser.

Validation:

```bash
pnpm exec vitest run packages/control-plane/src/runtime/debugTokenStore.test.ts packages/control-plane/src/runtime/runtimeDebugService.test.ts
```

## Task 3: Secure the editor debugger boundary

- Launch Godot 4.7 with the authenticated debugger and native `DebugAdapterServer` assigned one port so DAP never obtains a startup listener.
- Invoke its idempotent exit-tree stop path without freeing the editor-owned node.
- Require a one-use, ten-second, owner-only project/port launch attestation plus identical debugger/DAP ports; copied user arguments and ordinary launches remain ineligible for runtime debugging.
- Refuse `runtime.prepare` unless the guard is active.
- Return `{ debugPort, editorPid, debugTransport: "authenticated-editor-session" }`.
- Prove editor ownership of the debugger listener before launching the runtime.
- Require the authenticated owned PID and one unambiguous `EditorDebuggerSession` before constructing debugger state.
- Start an in-child watchdog thread before authentication so lease expiry remains enforceable while the main thread is debugger-stopped; the watchdog terminates only its own process.
- If another debugger session appears after certification, revoke the authenticated child's private lease instead of issuing a raw PID kill.

Validation:

- Real editor integration connects to the shared debugger port, sends a valid DAP initialize frame, and receives no DAP protocol data.
- Runtime launch rejects absent transport metadata or a native DAP server that was not disabled.

## Task 4: Implement breakpoints and execution control

- Validate the entire breakpoint replacement set before side effects.
- Canonicalize real paths and reject traversal, symlinks, hidden paths, non-GDScript paths, and addon paths.
- Apply source-scoped breakpoint replacement through the bound editor session.
- Track bounded stop events from `breaked`/`continued` session signals.
- Implement status, wait, pause, continue, step-over, and step-into.
- Preserve a newer stop that races ahead of an execution-control response.
- Clear MCP-owned breakpoints on every cleanup path.

Validation:

```bash
pnpm exec vitest run packages/control-plane/src/runtime/runtimeDebugService.test.ts tests/security/runtime-debugging-hostile.test.ts --fileParallelism=false
```

## Task 5: Implement bounded stack, variables, children, and watches

- Capture the stopped GDScript `ScriptBacktrace` inside the authenticated runtime.
- Immediately project frames and scoped variables into bounded data and release the engine backtrace before execution resumes.
- Filter addon frames from MCP results.
- Redact secret-named values.
- Summarize objects; expand only arrays and dictionaries.
- Truncate values at a valid UTF-8 boundary.
- Resolve exact selector watches without evaluation or method invocation.

Validation:

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm exec vitest run tests/integration/runtime-debugging.test.ts --fileParallelism=false
```

The integration must prove real breakpoints, nested game frames, locals, dictionary watch traversal, continue, token invalidation, and native-DAP inertness.

## Task 6: Implement monitor and profiler evidence

- Sample allowlisted public `Performance` groups and finite custom monitors.
- Implement one cancellable bounded profiling job.
- Add min/max/mean/p50/p95/p99 aggregates and optional deterministic raw retention.
- Report renderer/GPU capability honestly.
- Compute the evidence digest from the same canonical JSON representation used by the bridge, including canonical non-finite float tags.
- Keep audit summaries free of monitor names/values and samples.

Validation:

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm exec vitest run tests/integration/runtime-performance.test.ts --fileParallelism=false
```

## Task 7: Hostile, E2E, and cleanup coverage

- Reject missing grants/packs, invalid paths, duplicate sources, oversized counts, forged/stale tokens, malformed reserved float shapes, ambiguous debugger bindings, and invalid job transitions.
- Exercise crash, editor disconnect, runtime stop, MCP shutdown, profile cancellation, and repeated cleanup.
- Prove published stdio behavior and unchanged tool counts.
- Prove no fixture diff, descriptor/lease/job residue, owned process, or recorded listener remains.

Validation:

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm exec vitest run tests/security/runtime-debugging-hostile.test.ts tests/end-to-end/phase-7.test.ts --fileParallelism=false
```

## Task 8: Document and certify

- Update the Phase 7 design, bridge contract, threat model, testing guide, README, and contributor pointers.
- Run focused validation while developing.
- Commit the complete Phase 7 diff so the clean-tree gate can run.
- Run the authoritative gate and earlier regression gates.
- Run branch autoreview; fix accepted findings and repeat affected checks until clean.

Final commands:

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-7
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-0-1
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-2
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-3
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-4
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-5
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-6
/Users/tony/.agents/skills/autoreview/scripts/autoreview --mode branch --base main --engine codex
```

Expected: every gate exits zero, cleanup/diff checks are clean, and autoreview reports no actionable findings. Only then mark Phase 7 green and begin Phase 8.
