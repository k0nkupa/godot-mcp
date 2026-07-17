# Godot MCP bridge protocol v1

The Phase 7 editor bridge is JSON over a loopback WebSocket at `ws://127.0.0.1:<ephemeral-port>/bridge`. The server writes the address and one-use authentication material to an owner-only pairing descriptor. The addon initiates the connection; it opens no port.

## Pair request

The first text frame is an unsigned, complete `pair` object. Its fields are the literal method `pair`; the one-use 32-byte base64url token and session nonce; protocol and product versions; the project UUID, canonical root, and `project.godot` SHA-256; the installed addon manifest SHA-256; and the full Godot version.

No other unauthenticated message is accepted. Invalid JSON or an incomplete shape returns `INVALID_REQUEST`; a wrong secret or project UUID returns `AUTHENTICATION_FAILED`; a matching project whose `project.godot` fingerprint changed returns `PROJECT_CHANGED`.

## Pair response and proof

The server consumes the descriptor, creates a session ID and server nonce, and returns `pair_ok` with the session's granted tiers/packs and an HMAC server proof. Grants are observe/core by default; runtime requires explicit `runtime_control` and `runtime`, while input requires explicit `runtime_control` and `input`. The addon validates the proof, derives the session key, and sends a signed `pair.ack` containing the proof. The server answers with signed `pair.complete`; the addon clears the token and sends signed `addon.ready` with its identity, version, feature tags, addon hash, and plugin state.

Protocol or product mismatches are rejected. Phase 1 requires Godot `4.7.stable`; support for earlier 4.x releases is not yet certified.

## Signed envelopes

A signed envelope contains the session ID, positive integer sequence, positive Unix-millisecond deadline, method, JSON-shaped parameters, and lowercase hexadecimal HMAC-SHA-256.

The MAC is HMAC-SHA-256 over these newline-separated fields:

```text
sessionId
sequence
deadlineUnixMs
method
canonicalJson(params)
```

Canonical JSON sorts object keys, preserves array order, and allows null, booleans, strings, and safe integers. Before signing and transport, each finite non-integral parameter is replaced on the wire with `{ "$godotMcpFloat64Le": "<16 lowercase hex characters>" }`, where the value is its exact IEEE-754 binary64 bit pattern encoded least-significant byte first. The receiver verifies the MAC over that tagged wire value before decoding it back to a numeric parameter for dispatch. This avoids both JavaScript/Godot decimal-format drift and loss of precision in Godot's JSON number parser. Integral wire numbers within JavaScript’s safe-integer range remain ordinary JSON numbers.

Sequences must increase strictly for each direction. Deadlines must be unexpired and no more than 60 seconds in the future. A bad MAC, repeated sequence, wrong session ID, malformed envelope, or invalid deadline closes the session.

## Phase 2 editor commands

After `pair.complete`, the server may send signed `editor.query` or `editor.capture` envelopes. Parameters contain a UUID `requestId` and an `arguments` object. The signed envelope deadline is authoritative: the addon rejects an expired queued command before executing it. At most 32 editor commands may wait and only one runs at a time on Godot's main thread.

`editor.query` supports exactly `editor_state`, `scene_tree`, `node`, `resources`, `project_settings`, and `diagnostics`. Results are JSON-only and limited to 512 KiB. `editor.capture` supports the current `2d` viewport or `3d` viewport index 0–3, with requested dimensions no larger than 2048×2048. It returns PNG only, capped at 8 MiB decoded.

The addon replies with signed envelopes in this order:

```json
{ "method": "command.chunk", "params": { "requestId": "...", "index": 0, "total": 2, "sha256": "...", "data": "<base64>" } }
{ "method": "command.result", "params": { "requestId": "...", "ok": true, "data": {}, "binary": { "size": 700000, "sha256": "...", "chunks": 2 } } }
```

Errors use one terminal `command.result` with `ok: false` and a bounded `{ code, message, retryable }` error. A request has exactly one terminal result. Chunks are allowed only before that result, must start at zero, remain contiguous, agree on `total` and SHA-256, and use no more than 16 chunks of at most 512 KiB decoded each. The receiver verifies declared count, decoded length, and digest before exposing bytes. Duplicate, out-of-order, oversized, late, or digest-mismatched chunks reject the request and discard its buffered state.

The addon uses a bounded one-MiB outbound queue and drains between capture chunks; this does not raise the server's one-MiB per-frame limit. Timeouts, cancellation, protocol rejection, or either peer disconnecting reject all matching pending requests and erase accumulated chunks. Stale results cannot be reassigned to a later request because correlation IDs are unique per session.

## Phase 3 runtime commands

An explicitly runtime-authorized session may additionally send `runtime.prepare`, `runtime.command`, `runtime.capture`, and `runtime.cleanup`. These use the same signed envelope, queue, deadline, correlation, chunk, and terminal-result rules as editor commands. The addon rejects them when the session grants omit either the tier or pack.

`runtime.prepare` supplies a bounded descriptor for one run. Separately from the editor pairing descriptor, the control plane creates an owner-only runtime descriptor containing project identity, MCP session, run UUID, positive generation, scene path, owner heartbeat lease, launch nonce, 256-bit secret, and expiry. The owned Godot child consumes and deletes it, then proves possession in its first `godot_mcp_runtime:hello` debugger message. The editor debugger plugin verifies all identities, expiry, and HMAC before returning a second domain-separated HMAC over the complete hello transcript. The harness verifies that server proof in constant time before enabling commands or erasing its secret, providing mutual authentication across the debugger channel. The control plane accepts readiness only when the mutually authenticated PID equals its owned child PID.

`runtime.command` permits only status, bounded tree/node/log reads, typed waits, pause, resume, deterministic frame step, stop, and the separately input-pack-gated `input` operation. Input arguments contain one validated operation and owned-run handle; public variants are `send`, `sequence`, `record_start`, `record_stop`, and `replay`. Every command carries the run handle, strictly increasing runtime sequence, and deadline. Stale generations, replayed/reordered messages, wrong debugger sessions, and expired commands are rejected. `runtime.capture` returns one bounded PNG per bridge request; the MCP layer issues sequential requests for ordered multi-frame capture and verifies every digest before evidence persistence. `runtime.cleanup` clears prepared identity, pending requests, ready state, and debugger binding idempotently.

The runtime opens no listener and receives no WebSocket credentials. It connects only to the editor's loopback Godot debugger server. The TypeScript process owner launches only the fixed harness scene, scrubs the child environment, records PID/start fingerprint, and signals only that verified child during cleanup. The harness checks a descriptor-bound owner-only heartbeat lease twice per second and exits when a hard-killed MCP owner stops refreshing it.

## Phase 4 input receipts and traces

Input uses canonical JSON v1 safe integers. Strengths, pressure, tilt, magnification, normalized coordinates, and joy axes are fixed-point integer millionths; viewport/embedder pixels remain bounded integers. Sequences and traces contain at most 256 events with nondecreasing frame offsets 0–1,800 and deadlines no longer than 30 seconds. Positional targets are only `.` or relative descendant viewports; the harness constructs only the closed action, key, mouse, touch, gesture, and joypad event union.

Realtime sequences are marked non-deterministic. Deterministic sequences and replay require a paused runtime, process zero-based rendered frames through the shared frame clock, and leave the runtime paused. A trace records only successfully injected MCP events relative to its first delivery; no ambient OS event is observed. `record_stop` is the only operation returning a trace payload.

Every success includes a summary receipt: run handle, operation, requested/delivered counts, event kinds, scheduled/delivered offsets, optional viewport/coordinate metadata, release kinds, deterministic and recording flags, and canonical trace SHA-256. Audit records replace raw arguments with kind counts, frame range, mode, and digest. Action names, keycodes, coordinates, and trace payloads are excluded. Held MCP input is neutralized on terminal paths when the harness remains reachable.

## Phase 5 editor mutation

An editor-authorized session may send `editor.mutate` only when both `project_mutate` and the `editor` pack are present. It carries one of four strict operations: side-effect-free `preview`, digest-bound `apply`, action-scoped `undo`, or action-scoped `redo`. The addon routes it through the bounded main-thread queue.

A preview contains 1–32 closed-union steps and returns one history identity, ordered preconditions, target revisions, planned changes, and a SHA-256 plan digest. Apply repeats the exact steps and expected digest. Each apply/undo/redo carries a UUID idempotency key; the control plane hashes the key and canonical request into an owner-only append-only journal before dispatch. A completed record replays its receipt, while a crash-left started record returns `CONFLICT` and requires target reconciliation.

One batch resolves to one already-open scene history or global project-file history. Scene actions use native `EditorUndoRedoManager`; undo/redo refuses when the requested MCP action is not at the expected top-of-history state. File actions recheck containment and preimage hashes immediately before effect, use same-directory atomic replacement or journal tombstones, refresh only touched editor filesystem entries, and retain at most eight files or 4 MiB of preimages.

Mutation errors extend the bounded command error with `failedPhase`, `partialEffects`, `rollback`, and `safeRecovery`. Receipts and audit records include identities, preconditions, changes, warnings, and rollback state, but never raw idempotency keys or sensitive property values.

## Phase 7 runtime debugging and performance

`runtime.prepare` also returns the editor PID and explicit DAP port. The control plane accepts DAP only on `127.0.0.1`, requires debugger and DAP ports to be distinct, and proves with the host process table that the recorded editor PID owns both listeners. It attaches only after the runtime descriptor handshake has authenticated the owned child PID and identified its editor debugger session. Preparation refuses another active debugger session; attach and every debugger operation verify that the authenticated session remains the sole active session and fail closed on ambiguity.

The DAP client has no public passthrough. Its complete outbound command set is initialize, attach, disconnect, setBreakpoints, threads, stackTrace, scopes, variables, pause, continue, next, and stepIn. Framing requires one CRLF-only Content-Length header and a JSON-object body of at most one MiB. Requests are serialized and bounded by deadlines; unknown response IDs, forbidden commands, malformed frames, event overflow, transport loss, and late responses fail closed.

Debugger operations are carried by the existing `godot_runtime` tool: set/clear breakpoints, status, wait, pause, continue, step over/into, stack, variables, children, and selector watches. Breakpoints are canonical project-local GDScript locations outside the addon. DAP frame and variable IDs are replaced with opaque tokens bound to run ID, runtime generation, DAP generation, and stop sequence. Tokens become stale on execution, a new stop, reconnect, shutdown, or generation change. Watches traverse exact scope/name/index selectors in returned variable trees and never use DAP evaluate.

Performance operations on the same tool are monitor snapshot, profile start/status/cancel/result. The harness samples public `Performance`, `EngineProfiler`, `RenderingServer`, and `RenderingDevice` APIs only. One job runs at a time for 100 ms–30 seconds with an interval of 1–120 frames, at most eight requested groups, 128 metrics, 2,048 retained samples, and four MiB of complete wire-encoded terminal evidence. Terminal evidence records completeness, cancellation/failure reason, engine metadata, aggregates, optional bounded samples, current-job GPU timestamps, and a canonical SHA-256. Audit stores only bounded operation/count/state/digest metadata, never debugger values, watches, monitor samples, or raw profile evidence.

## Limits and closes

- Text frames only; binary frames close with policy violation (`1008`).
- Maximum WebSocket payload: 1 MiB; larger frames close with `1009` and audit `PAYLOAD_TOO_LARGE`.
- A second pending or attached client closes with `1008` and `AUTHENTICATION_FAILED`.
- Pairing has a five-second production timeout and descriptors expire after 60 seconds.
- Server shutdown removes any unconsumed descriptor and closes owned clients idempotently.
