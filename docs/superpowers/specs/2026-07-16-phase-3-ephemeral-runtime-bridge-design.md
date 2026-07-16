# Phase 3 Ephemeral Runtime Bridge Design

- **Date:** 2026-07-16
- **Status:** Approved design
- **Parent contract:** `docs/superpowers/specs/2026-07-15-godot-mcp-master-design.md`
- **Prerequisite:** Certified Phase 2 editor observation
- **Initial certification target:** macOS on Apple Silicon, Godot `4.7.stable.official.5b4e0cb0f`

## 1. Purpose

Phase 3 adds an authenticated, ephemeral bridge to one MCP-owned Godot debug process. It supports instrumented scene launch and lifecycle, bounded runtime observation, deterministic waits, pause/resume/frame stepping, runtime screenshots, and bounded multi-frame capture without changing the selected project's main scene or adding a permanent autoload.

The phase preserves all Phase 0-2 attachment, identity, replay, deadline, redaction, evidence, and cleanup invariants. It adds no input automation, project mutation, arbitrary method invocation, arbitrary GDScript, debugger stacks or breakpoints, build/export operations, shell access, general process tools, host filesystem tools, or network tools.

## 2. Authorization and tool surface

Runtime capability is opt-in at MCP startup:

```text
godot-mcp connect <project> --grant runtime_control --pack runtime
```

Without both the `runtime_control` permission tier and `runtime` capability pack, the session remains Phase 2 observe-only and exposes only the six core tools.

An authorized Phase 3 session exposes two additional cohesive tools:

- `godot_runtime`: launch, status, tree, node, logs, wait, pause, resume, step, and stop.
- `godot_runtime_capture`: single-frame or bounded multi-frame running-game PNG capture.

Both tools require `runtime_control` plus `runtime`. They are closed-world, do not mutate project files, and may affect only the MCP-owned ephemeral runtime process.

Tool visibility changes only when startup authorization or attachment state changes. An ordinary tool call never grants a pack or changes the tool list.

## 3. Architecture

The TypeScript control plane owns the runtime process. It launches the exact configured Godot binary as a child process with the canonical project root, the installed harness scene, and a loopback-only remote debugger endpoint. It records the PID, process start fingerprint, project identity, run identifier, generation, and launch arguments needed for safe cleanup.

The installed addon registers a focused `EditorDebuggerPlugin`. Godot's standard debugger transport is the only runtime communication channel:

```text
Codex
  -> MCP stdio server
  -> policy and runtime service
  -> authenticated editor WebSocket bridge
  -> EditorDebuggerPlugin
  -> Godot EngineDebugger
  -> ephemeral runtime harness
```

The runtime harness opens no listener. It is launched only for an authorized run and unregisters its debugger capture during shutdown.

### 3.1 Runtime preparation

Before process launch, the control plane creates a run record, a one-use runtime descriptor, and an owner heartbeat lease in the private Godot MCP runtime directory. Both files are regular owner-readable files with mode `0600`, bounded server-generated names, and no project-controlled path components. The descriptor expires after no more than 60 seconds and contains the run identifier, generation, project identity, MCP session identifier, heartbeat lease path, launch nonce, and a random 256-bit secret. The MCP owner refreshes the lease while the run is active; the harness exits when it becomes stale, including after an ungraceful owner-process death.

The control plane sends the expected run identity and proof-verification material to the attached addon through the existing authenticated editor bridge. The addon accepts only one prepared run for the current MCP session and expires unused preparation state.

The descriptor's absolute path is passed after Godot's engine argument separator. It is the only host path accepted by the harness and must resolve inside the known private runtime directory with the expected filename and ownership properties.

### 3.2 Runtime launch

The control plane starts Godot with these semantic arguments:

```text
<godot-bin>
  --path <canonical-project-root>
  --scene res://addons/godot_mcp/runtime/runtime_harness.tscn
  --remote-debug tcp://127.0.0.1:<editor-debug-port>
  --
  --godot-mcp-runtime-descriptor=<private-descriptor-path>
```

The control plane never accepts caller-supplied engine flags, executable paths, debugger endpoints, environment entries, or host paths. It uses a scrubbed allowlist environment and does not inherit credential-shaped variables. The selected scene is supplied inside the authenticated descriptor and must be an indexed `.tscn` resource contained by the attached project.

The addon reports the active editor debugger port through an authenticated preparation response. Non-loopback debugger endpoints are rejected.

### 3.3 Harness scene and instrumentation parity

The harness consumes and deletes the descriptor before accepting commands. It loads and instantiates the selected `PackedScene`, adds the game scene to the `SceneTree` root, and assigns it as `SceneTree.current_scene`. The instrumentation node remains a sibling outside the game-owned scene subtree.

Normal runtime queries begin at the game scene and exclude instrumentation. A diagnostic status operation may report the instrumentation node separately. The fixture certification records the extra node and confirms that the game scene's owned subtree, lifecycle callbacks, viewport dimensions, physics ticks, and frame progression match a non-instrumented fixture run within defined deterministic tolerances.

The harness never changes `project.godot`, the configured main scene, autoloads, project resources, import state, editor selection, or open editor scenes.

## 4. Runtime authentication

The harness reads the one-use secret, deletes the descriptor, and sends a hello message through `EngineDebugger` containing the run identifier, generation, project identity, launch nonce, runtime PID when available, and a keyed proof over the canonical hello fields. After verifying that proof, the editor plugin returns a domain-separated keyed proof over the full hello transcript. The harness verifies the server proof in constant time before enabling commands or erasing the secret, so debugger attachment is mutually authenticated rather than relying on loopback listener identity alone.

The editor debugger plugin accepts the hello only when:

- the preparation belongs to the active authenticated MCP session;
- the run identifier, generation, project identity, and nonce match;
- the descriptor has not expired or been consumed;
- the proof validates in constant time;
- the debugger session has not already been bound; and
- the process identity matches the control plane's owned launch record.

Successful binding erases secret material from addon memory and reports the debugger session identifier to the control plane. Replayed, reordered, expired, wrong-project, wrong-generation, or forged hellos are rejected and trigger owned-process cleanup.

All subsequent runtime messages carry the run identifier, generation, monotonically increasing runtime sequence, request identifier, deadline, operation, and payload. The editor plugin rejects stale generations, duplicate or reordered sequences, unknown requests, and messages after shutdown begins.

## 5. Public operations

### 5.1 `godot_runtime`

`godot_runtime` is a discriminated operation schema:

| Operation | Required input | Result |
|---|---|---|
| `launch` | `scenePath`, optional `startupTimeoutMs` | run identity, generation, owned process metadata, root node identity, viewport metadata |
| `status` | optional run identity | lifecycle state, pause state, frame counters, bound debugger state, process health |
| `tree` | run identity, optional `root`, `maxDepth`, `maxNodes` | bounded preorder game-scene subtree |
| `node` | run identity, `nodePath`, optional `includeProperties`, `includeSignals` | identity, class, groups, signals, script metadata, bounded readable properties |
| `logs` | run identity, optional sequence cursor, levels, limit | redacted runtime log, warning, and error records |
| `wait` | run identity and one typed condition | satisfied state, elapsed frames/time, last bounded observation |
| `pause` | run identity | paused state and frame counters |
| `resume` | run identity | running state and frame counters |
| `step` | run identity, `frames` | paused state and resulting frame counters |
| `stop` | run identity, optional grace period | final state, exit status, cleanup receipt |

Only one run may exist per MCP session. Launch while a run is starting, active, paused, stopping, or unreconciled returns `CONFLICT`.

Runtime node paths are relative to the selected game-scene root. Subnames, absolute paths, traversal, instrumentation paths, and caller-selected resource loads are forbidden. Property output uses the Phase 2 bounded variant encoder and secret/host-path redaction. Object and resource values are returned as metadata, never arbitrary bytes or source text.

Wait conditions are a closed union:

- `node_exists`
- `node_missing`
- `property_equals`
- `property_matches` for bounded primitive comparisons only
- `signal_emitted`
- `log_matches`
- `frames_elapsed`

Waits poll through the harness without busy-looping, have a maximum 30-second deadline, and return `TIMEOUT` with the last safe observation. They do not invoke arbitrary methods or expressions.

Pause and resume use `SceneTree.paused`. Frame stepping requires the run to be paused, advances one to 120 explicit process frames, and returns to the paused state. A step request that cannot preserve paused state fails rather than silently resuming continuous execution.

### 5.2 `godot_runtime_capture`

The capture schema contains:

- run identifier and generation;
- maximum width and height from 1 to 2048;
- frame count from 1 to 8;
- interval frames from 1 to 120 when frame count is greater than one; and
- an explicit `advancePaused` boolean, defaulting to `false`.

Each PNG is limited to 2048 by 2048 pixels and 8 MiB decoded. Phase 2's signed command chunks remain limited to 512 KiB each and 16 chunks per PNG.

Multi-frame capture is implemented as an ordered series of individually requested, verified, and persisted PNGs. This avoids changing the established single-binary bridge result contract. When the run is active, the harness waits the requested number of process frames between captures. When paused, capture returns the current frame repeatedly unless `advancePaused` is true; with that flag it performs explicit frame steps and restores paused state.

The MCP result returns ordered image content blocks plus structured per-frame metadata, a content-addressed PNG URI, and an append-only observation URI for each capture occurrence. Observation receipts preserve run, generation, and frame-index provenance even when multiple frames have identical PNG bytes. Base64 image data never appears in structured output or audit JSONL.

## 6. Runtime service and lifecycle

The control plane maintains a finite-state machine:

```text
idle -> preparing -> launching -> authenticating -> running <-> paused
                                      |               |
                                      v               v
                                    failed          stopping
                                                        |
                                                        v
                                                      stopped
```

Every terminal path reconciles the descriptor, debugger binding, child process, pending requests, temporary logs, and run record. A new generation may begin only after reconciliation reaches `idle` or a fully cleaned `stopped` state.

Cooperative stop first asks the harness to quit and waits for the configured grace period. Escalation sends termination only to a PID whose start fingerprint and run record still match. If ownership cannot be proven, the service refuses the signal and returns a cleanup error with a safe recovery action. It never terminates by process name.

MCP disconnect, editor bridge disconnect, addon exit, server shutdown, runtime crash, authentication failure, timeout, and explicit stop all use the same idempotent cleanup service. Cleanup may be called repeatedly.

## 7. Errors and audit

Phase 3 uses the existing result envelope and stable errors. It adds or exercises:

- `PERMISSION_REQUIRED`
- `NOT_ATTACHED`
- `TARGET_NOT_FOUND`
- `STALE_HANDLE`
- `PRECONDITION_FAILED`
- `CONFLICT`
- `TIMEOUT`
- `CANCELLED`
- `AUTHENTICATION_FAILED`
- `PROJECT_CHANGED`
- `GODOT_PARSE_ERROR`
- `GODOT_RUNTIME_ERROR`

Errors include the correlation identifier, failed lifecycle phase, retryability, partial-effect state, cleanup outcome, and safe recovery action. Raw runtime stacks, secret material, descriptor paths, and absolute host paths remain out of normal model-facing content.

Every operation appends an audit receipt containing the MCP session, project identity, run identifier and generation, permission tier and pack, normalized arguments, lifecycle transition, owned process fingerprint, outcome, error code, evidence references, and cleanup status. Secrets and runtime descriptor paths are redacted.

## 8. Bounds

- One prepared or active runtime per MCP session.
- At most 16 pending editor-bridge requests and one active main-thread editor command, preserving Phase 2 limits.
- Runtime tree: at most 1,000 nodes and depth 32.
- Runtime node: at most 128 encoded properties and 128 signals.
- Runtime logs: 500-entry in-memory ring and at most 500 records per response.
- Runtime JSON response: at most 512 KiB.
- Wait deadline: at most 30 seconds.
- Frame step: one to 120 frames.
- Capture: at most eight PNG frames; each at most 2048 by 2048 pixels and 8 MiB.
- One runtime capture request in flight per MCP session.
- Runtime descriptor expiry: at most 60 seconds and one successful use.

Oversized or over-limit requests fail before execution. Oversized runtime responses are truncated only where the schema explicitly defines pagination; otherwise they fail with `PAYLOAD_TOO_LARGE`.

## 9. Fixture coverage

The Godot 4.7 fixture gains a deterministic runtime scene containing:

- a stable 2D visual with multiple colors;
- a counter advanced by process frames;
- a physics counter advanced by physics frames;
- nested nodes, groups, typed signals, and bounded properties;
- deterministic signal emissions;
- normal log, warning, and deliberate error events;
- a property transition suitable for waits; and
- animation sufficient to prove ordered multi-frame changes.

All runtime, destructive, hostile-input, crash, and cleanup tests use disposable fixture copies. The source fixture and `/Users/tony/Projects/town-building-game` are not mutated.

## 10. Certification gate

The authoritative Phase 3 gate is:

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-3
```

It requires a visible macOS WindowServer session and exact Godot `4.7.stable.official.5b4e0cb0f`. It covers:

1. generated protocol drift;
2. build, lint, and typecheck;
3. package and focused runtime unit tests;
4. disposable fixture import and baseline smoke run;
5. runtime descriptor and proof fixture parity;
6. real editor debugger-plugin registration and cleanup;
7. authenticated launch and runtime fixture truth;
8. tree, node, signals, logs, errors, and wait conditions;
9. pause, resume, deterministic stepping, and stale-generation rejection;
10. nonblank runtime PNG and ordered multi-frame evidence;
11. wrong-project, expired, replayed, forged, reordered, oversized, and deadline-hostile cases;
12. runtime crash, editor exit, server exit, and repeated cleanup recovery;
13. published MCP stdio end-to-end acceptance with explicit runtime grants;
14. zero project diff, no descriptor, no debugger binding, and no owned process after normal and failed runs; and
15. `git diff --check`.

Before Phase 3 is claimed complete, these existing regression gates also pass:

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-0-1
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-2
```

No skipped stage is described as passed.

## 11. Completion boundary

Phase 3 is complete only when an explicitly authorized session can launch one selected fixture scene, authenticate the harness, inspect and control its bounded runtime lifecycle, capture verified running-game images, survive hostile inputs and process failures, and leave no project diff, stale descriptor, debugger binding, or owned process.

Input injection and replay remain Phase 4. Editor mutations remain Phase 5. Breakpoints, stacks, variables, watches, and profiling remain Phase 7. Declarative playtest scenarios and visual comparison remain Phase 8. General job and evidence-retrieval tools remain later roadmap work.
