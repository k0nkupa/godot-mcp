# Phase 7 debugging and performance certification

Phase 7 extends the existing runtime-authorized surface with native read-only GDScript debugging and structured performance evidence. It adds no MCP tool, tier, or capability pack. Observe-only sessions still expose exactly six tools; `godot_runtime` and `godot_runtime_capture` still require both `runtime_control` and `runtime`.

## Certified debugger contract

- `debug_breakpoints_set` sets or clears at most 64 unique breakpoints across 16 canonical project-local `.gd` files outside `res://addons/godot_mcp`.
- `debug_status`, `debug_wait`, and `debug_pause` expose bounded stop state; `debug_continue`, `debug_step_over`, and `debug_step_into` control only the authenticated owned child.
- `debug_stack`, `debug_variables`, and `debug_children` return at most 64 frames, 256 entries per page, 2,048 entries per stop-bound token set, and depth eight.
- `debug_watch` accepts at most 32 exact locals/members/globals selector paths of depth eight. It traverses returned variables and never evaluates expressions or invokes methods.
- Frame and variable references are 256-bit opaque tokens bound to run ID, generation, DAP generation, and stop sequence. They become stale on continue, step, a new stop, reconnect, stop, crash, disconnect, or close.

The TypeScript DAP client attaches only after runtime authentication, after the editor PID is proven to own distinct loopback debugger and DAP listeners, and while the authenticated runtime is the sole active editor debugger session. That binding is rechecked after attach and before every debugger operation. Its outbound allowlist excludes launch, terminate, evaluate, variable mutation, method calls, and raw protocol passthrough.

## Certified performance contract

- `monitor_snapshot` returns finite public engine monitor groups, bounded unavailability details, engine metadata, and explicit GPU timestamp support state.
- `profile_start`, `profile_status`, `profile_cancel`, and `profile_result` manage one job per runtime.
- A profile lasts 100 ms–30 seconds, samples every 1–120 frames, accepts at most eight unique groups, and retains at most 2,048 samples within a four MiB cap measured over the complete wire-encoded terminal evidence.
- Terminal evidence distinguishes complete, cancelled, and failed results; includes monotonic time/frame bounds, aggregates, optional bounded samples, engine/GPU metadata, and a canonical SHA-256.
- Performance results are observations, not deterministic benchmark claims. Tests assert structure and workload direction rather than machine-specific absolute timing.

Audit records contain debugger operation metadata and performance operation/count/state/digest summaries. They exclude variable/watch values, monitor samples, raw profile evidence, and source text.

## Gate

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-7
```

The 16-stage macOS gate pins Godot `4.7.stable.official.5b4e0cb0f`; checks generated protocol drift; runs build, lint, typecheck, focused Phase 7 tests, disposable import, Godot profiler/harness units, real DAP/profiler integrations, hostile inputs, published stdio, and the serialized full suite; then proves cleanup and clean committed/working diffs. Phase 0–1 through Phase 6 gates remain required regressions.

## Exclusions

Phase 7 does not provide expression evaluation, variable mutation, arbitrary DAP messages, arbitrary GDScript calls, host filesystem/network/process access, imported-asset mutation, builds/exports, or host-level CPU/GPU profiling. GPU timestamps are reported as unsupported when the renderer/platform does not expose them.
