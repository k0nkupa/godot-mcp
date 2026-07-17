# Phase 7 Debugging and Performance Design

**Status:** Approved

**Date:** 2026-07-17

## 1. Purpose

Phase 7 adds native GDScript debugging and bounded performance capture to the existing MCP-owned runtime. It must produce structured evidence for breakpoints, deliberate errors, stacks, variables, safe watches, remote objects, CPU, GPU, memory, frames, monitors, and profiler captures while preserving the Phase 0–6 security boundary and cleanup guarantees.

Phase 7 extends `godot_runtime`; it adds no MCP tool, permission tier, or capability pack. The default session still exposes exactly six observe-only tools. Debugging and performance operations are visible only when the session has both `runtime_control` and the `runtime` pack.

## 2. Architecture decision

Phase 7 uses two public Godot interfaces behind the existing control plane:

1. A minimal Debug Adapter Protocol client attaches to the already-running, mutually authenticated MCP-owned runtime through the editor's loopback DAP server.
2. The authenticated runtime harness samples public `Performance`, `RenderingServer`, and `RenderingDevice` data and implements cancellable profiling jobs.

The control plane remains the sole authority. It validates every operation, owns the runtime process and DAP connection, applies deadlines and bounds, redacts audit records, and converges all terminal paths on idempotent cleanup.

The implementation must not depend on Godot's private debugger message formats or editor UI node internals. Those interfaces would couple Phase 7 to one engine build and undermine the Phase 11 compatibility matrix.

## 3. Existing invariants retained

- MCP transport remains stdio.
- The editor bridge and Godot debug adapter bind only to `127.0.0.1`.
- Loopback is containment, not authentication.
- The runtime child is fixed, MCP-owned, environment-scrubbed, PID-fingerprinted, and mutually authenticated with a one-use descriptor.
- Project identity, session ID, run UUID, generation, launch nonce, strict sequences, and deadlines remain bound end to end.
- Only one MCP-owned runtime and one Phase 7 profiling job may be active per server.
- Runtime stop, crash, editor disconnect, DAP disconnect, MCP shutdown, deadline expiry, and owner death use idempotent cleanup.
- No operation may mutate the project checkout.
- Audit records contain operation metadata, counts, durations, hashes, and terminal status, but no breakpoint source text, variable values, watch values, monitor samples, or raw profiler data.

## 4. DAP containment and ownership

The addon reports the editor's configured DAP port together with the existing debugger port and editor PID during `runtime.prepare`. The control plane accepts the port only when it is an integer in `1024..49151` and a read-only host check proves that the same recorded editor PID owns a listener on `127.0.0.1:<dapPort>`.

The DAP client is created only after the existing runtime handshake has proven that the attached runtime PID equals the MCP-owned child PID. It performs `initialize`, then `attach` to the editor's current debugger session. It never sends DAP `launch`, `restart`, `terminate`, `setVariable`, `evaluate`, or Godot custom-message requests.

The DAP connection is scoped to the active runtime handle. A run ID or generation change invalidates it. A DAP `terminated`, `exited`, or transport failure marks debugger state unavailable without transferring authority to another editor run. A new MCP-owned runtime must create a new DAP session.

## 5. Runtime operation contract

The following discriminated operations are added to `godot_runtime`.

### 5.1 Breakpoints

`debug_breakpoints_set` replaces the complete Phase 7 breakpoint set for the active run.

Input:

- Active runtime handle.
- Zero to 64 breakpoints.
- Each breakpoint contains a canonical `res://` path ending in `.gd` and a one-based line in `1..1_000_000`.
- At most 16 distinct source files.

Rules:

- Paths must resolve inside the canonical project root, must not traverse, and must not target symlinks, hidden paths, or `res://addons/godot_mcp`.
- The control plane groups breakpoints by source and uses DAP source-scoped replacement semantics.
- The result reports the requested source/line, DAP verification state, resolved line when supplied, and a bounded diagnostic message.
- Breakpoints are cleared during every cleanup path. User-created editor breakpoints are not adopted as MCP breakpoints.

### 5.2 Debug state and stop events

`debug_status` returns DAP connection state, whether the runtime is stopped in the script debugger, the last bounded stop event, and breakpoint count.

`debug_wait` waits up to 30 seconds for a new stop event after an optional event sequence. Results distinguish `breakpoint`, `exception`, `step`, and `pause`. The result includes only bounded reason metadata; stacks and variables require separate operations.

`debug_pause`, `debug_continue`, `debug_step_over`, and `debug_step_into` control the GDScript debugger. They are distinct from the existing SceneTree pause/resume/frame-step operations.

- Continue and step require a stopped, debuggable DAP session.
- Debug pause requires an attached running session.
- A step completes only when the next matching stopped event is observed or the deadline expires.
- Phase 7 does not promise step-out because Godot 4.7's public DAP implementation does not provide it.

### 5.3 Stacks and variables

`debug_stack` requires a stopped session and returns at most 64 frames. Every frame contains a Phase 7 opaque frame token, bounded function name, canonical project-local source path when available, and one-based line and column.

Raw DAP frame IDs and variable references never cross the MCP boundary. The control plane maps them to opaque tokens bound to run ID, generation, stop-event sequence, and DAP connection generation. Tokens expire on continue, step, a new stop event, disconnect, or cleanup.

`debug_variables` accepts an opaque frame token and one scope from `locals`, `members`, or `globals`. It returns at most 256 entries and supports bounded pagination. Each entry contains an opaque variable token, name, type, display value truncated to 4,096 UTF-8 bytes, child availability, and truncation metadata.

`debug_children` accepts an opaque variable token and returns at most 256 immediate children. Recursive expansion is client-driven and capped at depth eight and 2,048 returned variables per stop event. Object fields are exposed through the same bounded child contract and satisfy the master design's remote-object evidence requirement.

### 5.4 Safe watches

`debug_watch` accepts one to 32 selectors. A selector contains:

- An opaque frame token.
- One scope: `locals`, `members`, or `globals`.
- A path of one to eight exact variable names or nonnegative array indices.

The control plane resolves selectors by traversing previously bounded DAP scopes and variables. It does not send DAP `evaluate`, execute getters explicitly, accept expressions, invoke methods, or mutate values. Results report `found`, `missing`, `truncated`, or `stale` with the final bounded variable representation.

## 6. Performance and profiler contract

### 6.1 Monitor snapshot

`monitor_snapshot` returns one structured sample from the authenticated runtime harness.

The sample contains:

- Monotonic frame and time identity.
- Engine version, renderer name, rendering method, and graphics API.
- Public built-in `Performance` monitors grouped as frame/CPU, memory, objects, rendering/GPU, physics, audio, navigation, and pipeline compilations.
- Public custom monitors with names capped at 128 bytes and numeric finite values only.
- Capability metadata for GPU timestamps and unavailable monitors.

The request may select named groups but cannot supply arbitrary monitor IDs or callables. Unknown or nonnumeric custom monitors are reported as unavailable, not coerced.

### 6.2 Cancellable profile jobs

`profile_start` creates one asynchronous job and returns an opaque job token. Input includes:

- Active runtime handle.
- Duration from 100 milliseconds through 30 seconds.
- Sampling interval from one through 120 rendered frames.
- One to eight monitor groups.
- Whether bounded raw samples are retained in addition to aggregates.

Only one job may exist at a time. A job retains at most 2,048 samples and 4 MiB of canonical structured data. If the requested cadence would exceed the sample cap, sampling continues at the requested cadence but raw retention is downsampled deterministically and the receipt reports observed and retained counts.

`profile_status` reports `running`, `completed`, `cancelled`, or `failed`, progress, observed samples, retained samples, and terminal reason.

`profile_cancel` is idempotent. It requests cancellation through the authenticated runtime command path, stops new sampling, finalizes bounded partial evidence, and returns the terminal receipt.

`profile_result` returns the terminal receipt and evidence. It refuses while the job is running.

### 6.3 Profile evidence

Profile evidence contains:

- Start/end monotonic times and frames.
- Requested duration and cadence.
- Observed, retained, invalid, and dropped sample counts.
- Minimum, maximum, arithmetic mean, p50, p95, and p99 for each continuously available numeric monitor.
- Optional bounded raw samples with stable monitor ordering.
- Engine, renderer, rendering method, graphics API, and viewport identity.
- GPU timestamp support and timestamp deltas when the active `RenderingDevice` supports captured timestamps.
- Cancellation or failure metadata and whether evidence is complete or partial.
- A SHA-256 digest over canonical evidence.

The harness registers a Phase 7 `EngineProfiler` implementation while a profile job is active. Its public `_tick` callback records frame, process, physics, and physics-frame timings into the same bounded sampler. This is profiler evidence; it does not claim access to Godot's private editor profiler history or native per-function profiler UI.

## 7. State machines

### 7.1 Debugger state

`disconnected -> connecting -> attached -> stopped -> attached`

Any state may transition to `failed` or `disconnected`. Only the active runtime handle may cause `connecting`. Cleanup always ends at `disconnected` and clears breakpoints, pending requests, stop events, and opaque token maps.

### 7.2 Profile job state

`idle -> running -> completed | cancelled | failed`

Terminal jobs remain readable until a new job starts or the runtime is cleaned up. Starting a new job discards the prior in-memory evidence after its audit digest has been recorded. Cancellation and cleanup are idempotent.

## 8. Deadlines, cancellation, and backpressure

- Every DAP request has a maximum 10-second deadline; `debug_wait` has a caller-selected maximum of 30 seconds.
- A single serialized DAP request queue prevents response misassociation.
- Content-Length frames are capped at 1 MiB; malformed headers, duplicate lengths, oversized bodies, invalid JSON, unknown response IDs, or response type mismatches fail the DAP session closed.
- DAP events are capped at 512 queued entries. Overflow fails the debugger connection rather than silently losing stop identity.
- Runtime profile commands retain the existing signed sequence and deadline checks.
- MCP cancellation of a pending wait cancels only that wait. Runtime stop, server close, DAP loss, or handle invalidation rejects all pending debugger work.
- Profile cancellation remains available through `profile_cancel`; owner cleanup also cancels it automatically.

## 9. Error mapping

- `STALE_HANDLE`: runtime handle, frame token, variable token, or job token belongs to an older generation.
- `CONFLICT`: debugger/profile state does not permit the requested operation or a job is already active.
- `PRECONDITION_FAILED`: the runtime is not stopped, DAP is unavailable, a source is outside policy, or a result is requested before completion.
- `INVALID_REQUEST`: schema, bound, path, selector, or pagination failure.
- `TIMEOUT`: DAP request, debug wait, step completion, or profile command exceeds its deadline.
- `GODOT_RUNTIME_ERROR`: authenticated runtime or public Godot API reports an operation failure.
- `TRANSPORT_ERROR`: the verified editor-owned DAP connection fails or violates framing.

Errors never include raw DAP frames, source contents, variable values, or profiler samples.

## 10. Cleanup

Cleanup performs the following actions in order where reachable:

1. Cancel and finalize an active profile job.
2. Reject pending debug waits and DAP requests.
3. Clear MCP-owned breakpoints.
4. Disconnect the DAP client without terminating or launching an editor runtime.
5. Clear stop events and opaque token maps.
6. Run the existing runtime cleanup for harness state, process ownership, descriptor, lease, debugger binding, and evidence buffers.

Failures are accumulated and reported after all cleanup actions have been attempted. Repeated cleanup is safe.

## 11. Test fixtures

The disposable Godot 4.7 fixture gains a dedicated debug scene and scripts containing:

- Two deterministic breakpoint sites.
- Nested function calls producing a known stack.
- Locals, members, globals, arrays, dictionaries, vectors, and one remote object with known values.
- A deliberate debuggable error path.
- Deterministic workload phases that change process time, object count, draw calls, memory, and custom monitors.
- A long-running workload for cancellation and crash recovery.

All editor, DAP, debugger, profiler, hostile-input, and E2E tests use disposable fixture copies and require zero source-fixture diff.

## 12. Phase 7 certification gate

`GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-7` must run ordered checks for:

1. Generated protocol drift.
2. Build, lint, and typecheck.
3. Protocol and DAP framing unit tests.
4. Runtime service state/token/job unit tests.
5. Disposable fixture import.
6. Godot debugger and profiler unit tests.
7. Editor-owned DAP listener verification.
8. Authenticated breakpoint, stack, variables, watches, remote-object, and execution-control integration.
9. Monitor snapshot and completed/cancelled/failed profiler evidence integration.
10. Deliberate error and recovery integration.
11. Hostile DAP frames, stale tokens, invalid paths, bounds, deadlines, and authorization rejection.
12. Crash, DAP loss, editor disconnect, runtime stop, and MCP shutdown cleanup.
13. Published stdio E2E with the unchanged runtime tool count.
14. Serialized full Vitest regression.
15. Fixture, descriptor, lease, process, job, and project cleanup verification.
16. `git diff --check` and committed/working-tree gate checks.

After `qa:phase-7` passes, the Phase 0–1 and Phase 2–6 gates run as regressions. Autoreview then reviews the complete Phase 7 branch diff. Any accepted finding is fixed and the affected validation and review are rerun. Phase 8 starts only after the final autoreview exits clean.

## 13. Documentation updates

Phase 7 updates:

- `docs/protocol/bridge-v1.md` with DAP containment, opaque debugger tokens, and profiling jobs.
- `docs/security/threat-model.md` with DAP and runtime-data disclosure threats and mitigations.
- `docs/testing/phase-7.md` with exact prerequisites, stages, bounds, and exclusions.
- `README.md` with the Phase 7 capability surface and certification command.
- `AGENTS.md` with the current Phase 7 plan and gate.

## 14. Explicit exclusions

Phase 7 does not add:

- Arbitrary expression evaluation or watches.
- DAP launch, restart, terminate, variable mutation, custom requests, or raw protocol passthrough.
- Native debugger support for C#, GDExtension, or engine C++.
- Private Godot editor profiler history or private debugger message parsing.
- Project mutation, import/reimport, plugin state, project settings mutation, build, export, or artifact management.
- Declarative playtest scenarios or screenshot-baseline comparison.
- Unsafe fixture execution or extension SDK capabilities.
- Windows, Linux, or Godot 4.4–4.6 certification.

Those remain assigned to later phases in the master design.
