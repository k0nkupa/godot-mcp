# Phase 7 debugging and performance certification

Phase 7 extends the existing runtime-authorized surface with native read-only GDScript debugging and structured performance evidence. It adds no MCP tool, tier, or capability pack. Observe-only sessions still expose exactly six tools; `godot_runtime` and `godot_runtime_capture` still require both `runtime_control` and `runtime`.

## Certified debugger contract

- `debug_breakpoints_set` sets or clears at most 64 unique breakpoints across 16 canonical project-local `.gd` files outside `res://addons/godot_mcp`.
- Breakpoint receipts remain honestly unverified because Godot 4.7's editor API does not confirm executable source lines; real stop behavior is certified by integration and E2E tests.
- `debug_status`, `debug_wait`, and `debug_pause` expose bounded stop state; `debug_continue`, `debug_step_over`, and `debug_step_into` control only the authenticated owned child.
- `debug_stack`, `debug_variables`, and `debug_children` return at most 64 frames, 256 entries per page, 2,048 entries per stop-bound token set, and depth eight.
- `debug_watch` accepts at most 32 exact locals/members/globals selector paths of depth eight. It traverses returned variables and never evaluates expressions or invokes methods.
- Dictionary selector metadata is emitted only for schema-selectable strings and bounded non-negative integers; oversized, empty, NUL-bearing, fractional, negative, and out-of-range keys remain visible only as unsupported bounded labels.
- Freed object references render as a fixed summary without invoking methods on the invalid instance.
- Frame and variable references are 256-bit opaque tokens bound to run ID, generation, authenticated debugger generation, and stop sequence. Historical wait events do not replace live debugger state, and every asynchronous evidence read revalidates the exact stopped sequence before returning. Tokens become stale on continue, step, a new stop, reconnect, stop, crash, disconnect, or close.
- Debugger display strings are UTF-8 bounded from a fixed-size character prefix, so enforcing the 4,096-byte wire cap never encodes an unbounded original value.

The certified `godot-mcp editor` launch assigns Godot's authenticated editor debugger and unauthenticated native DAP server to the same loopback port. The authenticated debugger binds first during editor startup, so native DAP never acquires a listener; the addon then stops the inactive native DAP plugin. Runtime preparation requires a ten-second, owner-only, project-and-port-bound launch attestation. The addon validates containment, regular-file shape, permissions, and size before reading and deleting it, so copied user arguments are insufficient and unrelated paths remain untouched. The control plane independently proves that the editor PID owns the debugger listener. The owned runtime must then authenticate as the sole active editor debugger session. An independent in-child lease watchdog remains live while the main thread is debugger-stopped and terminates only its own process after owner expiry or ambiguous-session lease revocation. The binding is rechecked before every debugger operation. The fixed internal command set excludes launch, public terminate, evaluate, variable mutation, method calls, sockets, and raw protocol passthrough.

## Certified performance contract

- `monitor_snapshot` returns finite public engine monitor groups, bounded unavailability details, engine metadata, and explicit GPU timestamp support state.
- `profile_start`, `profile_status`, `profile_cancel`, and `profile_result` manage one job per runtime.
- Active and terminal profile jobs remain bound to the owned runtime across ordinary game-scene transitions; runtime stop, exit, or explicit clear cancels and removes them.
- A profile lasts 100 ms–30 seconds, samples every 1–120 frames, accepts at most eight unique groups, and retains at most 2,048 samples within a four MiB cap measured over the complete wire-encoded terminal evidence.
- `droppedSamples` counts every observation absent from retained raw evidence, including both rejected samples and samples evicted by deterministic reservoir replacement.
- Requested built-in groups and EngineProfiler tick metrics take priority within the 128-metric sample cap. Custom monitors use the remaining capacity, and terminal evidence explicitly reports affected samples, dropped groups, and the maximum metrics dropped per sample.
- Terminal evidence distinguishes complete, cancelled, and failed results; includes monotonic time/frame bounds, aggregates, optional bounded samples, engine/GPU metadata, and a canonical SHA-256.
- Performance results are observations, not deterministic benchmark claims. Tests assert structure and workload direction rather than machine-specific absolute timing.

Audit records contain debugger operation metadata and performance operation/count/state/digest summaries. They exclude variable/watch values, monitor samples, raw profile evidence, and source text.

## Gate

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-7
```

The 16-stage macOS gate pins Godot `4.7.stable.official.5b4e0cb0f`; checks generated protocol drift; runs build, lint, typecheck, focused Phase 7 tests, disposable import, Godot profiler/harness units with script-error scanning and mandatory success markers, a shared-port native-DAP inertness probe, authenticated debugger/profiler integrations, hostile inputs, published stdio through a non-headless secure editor, and the serialized full suite; then proves cleanup and clean committed/working diffs. The native transition unit also proves profile status remains reachable without a bound scene. Phase 0–1 through Phase 6 gates remain required regressions.

## Exclusions

Phase 7 does not provide expression evaluation, variable mutation, raw DAP access, arbitrary debugger messages, arbitrary GDScript calls, host filesystem/network/process access, imported-asset mutation, builds/exports, or host-level CPU/GPU profiling. GPU timestamps are reported as unsupported because the runtime cannot bracket actual rendered work across frame boundaries honestly.
