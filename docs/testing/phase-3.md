# Phase 3 certification

The authoritative Phase 3 gate is:

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-3
```

It requires macOS with a visible WindowServer session, Node.js 22, pnpm 11.13.0, and exactly Godot `4.7.stable.official.5b4e0cb0f`. It runs 15 ordered stages: protocol drift, builds, lint, typecheck, package tests, disposable fixture import, cross-language proof parity, Godot harness deadline and runtime contract units, the real authenticated debugger bridge, bounded capture/evidence, hostile inputs, crash/disconnect cleanup, published stdio E2E, the full regression suite, and `git diff --check`.

## Authorized surface

The default connection still exposes six observe/core tools. Runtime is visible only when `connect` receives both `--grant runtime_control --pack runtime`; supplying only one flag is rejected. An authorized session adds `godot_runtime` and `godot_runtime_capture`.

`godot_runtime` owns at most one generation and supports launch, status, bounded tree/node/log reads, typed waits, pause, one-to-120-frame step, resume, and stop. Scene paths stay under `res://`; node paths are relative and reject traversal and subnames. Tree responses are limited to depth 32 and 1,000 nodes, node results to 128 properties and signals, logs to 500 records, and waits to 30 seconds.

`godot_runtime_capture` returns one to eight ordered PNG image blocks. Each frame is bounded to 2048×2048 and 8 MiB, delivered in the existing signed 512 KiB/16-chunk protocol, SHA-256 verified, and persisted under the session evidence directory. PNG blobs remain content-addressed, while every capture occurrence receives a separate owner-only observation receipt containing its run, generation, and frame index; identical paused frames therefore retain distinct provenance without duplicating image bytes. Structured and audit output contain metadata and opaque evidence URIs, never PNG base64.

## Ownership and cleanup proof

The server launches the exact configured Godot binary with a scrubbed environment and fixed harness scene. A one-use, owner-only descriptor binds project, MCP session, run ID, generation, owner heartbeat lease, nonce, expiry, and secret. The harness proves possession through Godot's loopback debugger channel, exits if the descriptor-bound heartbeat becomes stale, and the control plane requires the authenticated PID to equal its owned child PID.

Explicit stop, runtime crash, editor disconnect, MCP shutdown, authentication failure, and timeout converge on idempotent cleanup. Signaling is limited to the recorded PID after its process-start fingerprint is rechecked. Acceptance requires no descriptor, debugger binding, owned fixture process, or project diff after normal and failed runs.

Failure artifacts are retained only when the gate fails. They contain redacted editor/MCP logs, audit JSONL, and metadata-only receipts; descriptors, secrets, and raw/base64 PNG bytes are excluded. A passing gate removes its artifact directory. Phase 0–1 and Phase 2 gates remain separate mandatory regressions before release.

## Phase 3 limitations

The runtime harness is instrumentation, not a hostile-code sandbox. Phase 3 provides no input injection, arbitrary GDScript, generic method invocation, arbitrary filesystem/network/process access, project mutation, debugger stacks/breakpoints, profiler, build, export, or evidence-retrieval tool.
