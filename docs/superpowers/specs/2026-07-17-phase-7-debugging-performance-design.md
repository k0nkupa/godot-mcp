# Phase 7 Debugging and Performance Design

**Status:** Approved, security amendment incorporated

**Date:** 2026-07-17

## 1. Purpose

Phase 7 adds bounded GDScript debugging and performance evidence to the existing MCP-owned runtime. It supports breakpoints, stops, stacks, variables, selector watches, public performance monitors, and cancellable profiler captures without adding an MCP tool, permission tier, or capability pack.

The default session still exposes exactly six observe-only tools. Phase 7 operations remain available only through `godot_runtime` when both `runtime_control` and the `runtime` pack are granted.

## 2. Security-amended architecture

The initial design attached a TypeScript client to Godot's native loopback Debug Adapter Protocol server. Review rejected that architecture because Godot 4.7 accepts unrelated local DAP clients without authenticating them.

The approved implementation therefore has one debugger route:

1. The certified `godot-mcp editor` launcher assigns Godot's authenticated editor debugger and native DAP server one loopback port. Godot initializes the debugger listener first, so DAP never binds; a DAP initialize probe is rejected by the non-DAP debugger transport.
2. Runtime preparation succeeds only when the addon confirms that the native DAP server is disabled and reports `debugTransport: "authenticated-editor-session"` with the editor PID and debugger port.
3. The control plane proves the editor owns the loopback debugger listener, launches the fixed runtime harness, and waits for the existing one-use descriptor and signed hello exchange to authenticate the owned child PID and unique `EditorDebuggerSession`. It then certifies the independently verified child PID back to the editor so an editor-side lease watchdog can terminate that exact child even while the game main thread is stopped in the debugger.
4. Breakpoints and execution control use the bound `EditorDebuggerSession`. Stack and variable evidence is captured inside the authenticated runtime with `Engine.capture_script_backtraces(true)` and returned through the existing signed, sequenced, deadline-bound runtime command channel.
5. Performance evidence uses the same authenticated runtime channel with public `Performance`, `EngineProfiler`, `RenderingServer`, and `RenderingDevice` APIs.

The control plane remains the sole authority. It validates public inputs, owns runtime and debugger lifecycle, issues opaque stop-bound tokens, enforces bounds and deadlines, redacts audit records, and converges terminal paths on idempotent cleanup.

Godot 4.7 does not expose a supported switch that disables the native DAP editor plugin. Stopping it from the addon alone leaves a startup race, so that design was rejected in review. The CLI instead launches the editor with `--debug-server` and `--dap-port` targeting one port. The authenticated editor debugger wins the startup bind before DAP initialization; the addon then invokes the native plugin's idempotent `NOTIFICATION_EXIT_TREE` stop path without freeing its node. Runtime preparation requires the secure-launch marker, identical port arguments, and independent editor-PID listener ownership verification. This behavior is pinned to the certified Godot build and must be exercised by the Phase 11 compatibility matrix.

## 3. Retained invariants

- MCP remains on stdio; the bridge and runtime debugger bind only to `127.0.0.1`.
- Loopback is containment, not authentication.
- The runtime child is fixed, MCP-owned, environment-scrubbed, PID-fingerprinted, and mutually authenticated with a one-use descriptor.
- Project identity, session ID, run UUID, generation, launch nonce, strict sequence, and deadline remain bound end to end.
- Preparation refuses an already-active or ambiguous editor debugger session.
- Only one runtime and one profiling job may be active per server.
- No operation mutates the project checkout.
- Stop, crash, editor disconnect, runtime transport loss, MCP shutdown, deadline expiry, and owner death converge on idempotent cleanup.
- Audits contain metadata, counts, durations, hashes, and terminal status, not breakpoint source text, variable values, monitor samples, or profiler samples.

## 4. Closed debugger command surface

The internal authenticated debugger client has the exact command set `disconnect`, `setBreakpoints`, `threads`, `stackTrace`, `scopes`, `variables`, `pause`, `continue`, `next`, and `stepIn`.

These names are internal adapters, not a socket protocol or public passthrough. The addon maps them to a fixed implementation. There is no arbitrary debugger message, expression evaluation, method invocation, variable mutation, launch, restart, terminate, or custom request surface.

Execution control uses the bound editor debugger session. Stack capture immediately projects the `ScriptBacktrace` into bounded frame and variable snapshots and releases the backtrace before execution resumes. Retaining the engine backtrace across continue is forbidden because it can retire the editor debugger transport.

## 5. Runtime operation contract

### 5.1 Breakpoints

`debug_breakpoints_set` replaces the complete MCP-owned breakpoint set for the active run.

- Zero to 64 breakpoints across at most 16 source files.
- Canonical project-local `res://` GDScript paths only.
- No traversal, symlink escape, hidden path, or `res://addons/godot_mcp` target.
- Lines are one-based integers in `1..1_000_000`.
- All entries are validated before any breakpoint side effect.
- Godot's editor debugger API accepts source-line breakpoints but does not confirm whether a line is executable, so results remain `verified: false` with an explanatory message even when the breakpoint is installed.
- Cleanup removes only MCP-owned breakpoints.

### 5.2 State and execution

`debug_status` reports authenticated connection state, stopped state, stop sequence, and breakpoint count.

`debug_wait` waits up to 30 seconds for a stop newer than `afterSequence`. Results normalize to `breakpoint`, `exception`, `step`, `pause`, or `unknown`.

`debug_pause`, `debug_continue`, `debug_step_over`, and `debug_step_into` control the script debugger. Continue and step require a stopped session; pause requires a running session. A step completes only after a newer stop event. Step-out is excluded.

A stop that arrives before the execution-control response is preserved by sequence comparison; it must not be discarded as stale. Retained stop events are historical cursors, not live-state assertions: the control plane refreshes current debugger status after each wait and binds tokens only when the session is still stopped at that exact sequence.

### 5.3 Stacks and variables

`debug_stack` requires a stopped session and returns at most 64 frames. Addon frames are omitted from the MCP result. Each visible frame contains a 256-bit opaque token, bounded function name, canonical project-local source path when available, and line/column.

At capture time, the runtime projects locals, members, and globals into a bounded snapshot, records whether each scope was clipped, then releases the engine `ScriptBacktrace`. Secret-named variables are redacted. Object values are summaries only; child expansion is limited to arrays and dictionaries. Display values are capped at 4,096 valid UTF-8 bytes.

`debug_variables` returns one `locals`, `members`, or `globals` page. `debug_children` expands one opaque variable token. Pages contain at most 256 entries; recursive client expansion is capped at depth eight and 2,048 entries per stop. Scope clipping remains explicit so a full retained page still reports `truncated` when additional variables were omitted.

Frame and variable tokens bind run ID, runtime generation, authenticated debugger generation, and stop sequence. They expire on continue, step, a newer stop, reconnect, stop, crash, disconnect, or cleanup. Stack, scope, variable, child, and watch reads revalidate the live stopped sequence after every asynchronous debugger request before projecting evidence or issuing tokens.

### 5.4 Safe watches

`debug_watch` accepts one to 32 selectors. Each selector chooses a scope and a path of one to eight exact variable names or nonnegative array indices.

Resolution traverses only the bounded captured variable tree. It never evaluates an expression, calls a method or getter explicitly, or mutates a value. Results are `found`, `missing`, `truncated`, or `stale`.

## 6. Performance contract

`monitor_snapshot` returns bounded public monitor groups, engine/renderer identity, monotonic frame/time identity, custom finite numeric monitors, and capability metadata. It accepts named groups only, not arbitrary monitor IDs or callables.

`profile_start` creates one job with:

- duration `100..30000` milliseconds;
- interval `1..120` rendered frames;
- one to eight monitor groups;
- optional bounded raw retention.

The job retains at most 2,048 samples and 4 MiB of canonical evidence. `profile_status`, idempotent `profile_cancel`, and terminal-only `profile_result` use opaque run-bound job tokens. An active profiler is scene-independent: scene invalidation may block new snapshots or jobs, but status, cancel, and result remain routable through the retained profiler until terminal state or runtime cleanup.

Evidence contains timing/frame bounds, sample counts, min/max/mean/p50/p95/p99 aggregates, optional stable raw samples, engine/renderer identity, GPU timestamp capability, terminal metadata, and SHA-256 over the shared canonical JSON wire representation. Non-finite floats use the bridge's canonical tagged-float representation; malformed or reserved float-tag shapes are rejected.

## 7. Backpressure and errors

- Public runtime commands retain signed envelopes, strict sequences, and deadlines.
- Debug waits retain at most 512 stop events and return only events newer than the caller sequence.
- Captured frames, scopes, variables, selectors, text, and profile data have explicit bounds.
- `STALE_HANDLE` covers old runtime, frame, variable, or job identity.
- `CONFLICT` covers invalid debugger/profile state or an existing job.
- `PRECONDITION_FAILED` covers running/stopped-state mismatches and unavailable evidence.
- `INVALID_REQUEST` covers schema, path, selector, and pagination failures.
- `TIMEOUT` covers waits, steps, and runtime commands exceeding deadlines.
- `AUTHENTICATION_FAILED` covers missing authenticated debugger metadata, an active native DAP server, or ambiguous session binding.
- `TRANSPORT_ERROR` covers loss of the authenticated bridge/debugger channel.

Errors never include source contents, variable values, monitor samples, or raw profiler data.

## 8. Cleanup

Cleanup attempts every reachable action:

1. Cancel/finalize an active profile job.
2. Clear opaque debug tokens and pending waits.
3. Remove MCP-owned breakpoints through the authenticated editor session.
4. Close the internal debugger client.
5. Run the existing runtime cleanup for harness state, process ownership, descriptor, lease, debugger binding, and evidence buffers.
6. On addon exit, clear debugger state; ordinary non-certified launches also release their best-effort post-startup containment guard.

Repeated cleanup is safe; failures are accumulated only after all actions are attempted.

## 9. Certification

`GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-7` runs 16 ordered stages covering protocol drift, build/lint/typecheck, focused protocol/runtime/debugger tests, disposable import, GDScript units, a shared-port native-DAP inertness probe, real authenticated breakpoint/stack/variable/watch/control integration, profiler integration, hostile inputs, a published stdio E2E through the shipped non-headless secure-editor startup path, serialized regressions, cleanup, and clean committed/working diffs.

After that gate passes, the Phase 0–1 and Phase 2–6 gates run as regressions. Autoreview must then exit clean before Phase 8 begins.

## 10. Explicit exclusions

Phase 7 does not add expression evaluation, variable mutation, arbitrary debugger messages, raw DAP access, C#/GDExtension/native debugging, private editor-profiler history, project mutation, import/reimport, build/export, declarative scenarios, unsafe extension execution, or compatibility certification outside the Phase 11 matrix.
