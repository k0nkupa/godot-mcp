# Phase 10 unsafe fixture and extension gate

Run `GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-10`, then Phase 0–9 regressions. A skipped or failed stage is not green.

Unsafe fixture execution is deliberately unsandboxed. It requires `unsafe_fixture + unsafe`, a startup flag, an outside-MCP owner-only registration, a distinct stamped disposable copy, and a one-use activation created with the exact phrase `I UNDERSTAND THIS RUNS UNSANDBOXED CODE`. The lease expires in at most five minutes and is consumed even when validation fails.

The one tool supports bounded execute/status/cancel/result jobs. It launches only the configured Godot binary in a separate process, uses isolated HOME/XDG roots and a scrubbed environment, caps source at 64 KiB, output at 4 MiB, and execution at ten seconds, and signals only its PID/start fingerprint. Every receipt says `unsafe: true` and `sandboxed: false`. Source is deleted and never audited; residue blocks reactivation and export.

Extensions are trusted startup-allowlisted modules. One `godot_extension` tool validates typed input/output and routes each operation through its declared existing policy and normal audit path. Its frozen context contains only project identity, correlation ID, and protected JSON evidence writing. Extensions cannot request unsafe authority through the SDK.

The 16 stages are exact Godot version, generated drift, builds, lint, typecheck, protocol/policy units, registration/copy/lease, separate unsafe process, cancellation/expiry/residue, extension SDK, hostile matrix, published stdio acceptance, serialized regressions, cleanup, committed diff, and working-tree diff/cleanliness.
