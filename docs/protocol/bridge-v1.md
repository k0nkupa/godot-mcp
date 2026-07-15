# Godot MCP bridge protocol v1

The Phase 2 bridge is JSON over a loopback WebSocket at `ws://127.0.0.1:<ephemeral-port>/bridge`. The server writes the address and one-use authentication material to an owner-only runtime descriptor. The addon initiates the connection; it opens no port.

## Pair request

The first text frame is an unsigned, complete `pair` object. Its fields are the literal method `pair`; the one-use 32-byte base64url token and session nonce; protocol and product versions; the project UUID, canonical root, and `project.godot` SHA-256; the installed addon manifest SHA-256; and the full Godot version.

No other unauthenticated message is accepted. Invalid JSON or an incomplete shape returns `INVALID_REQUEST`; a wrong secret or project UUID returns `AUTHENTICATION_FAILED`; a matching project whose `project.godot` fingerprint changed returns `PROJECT_CHANGED`.

## Pair response and proof

The server consumes the descriptor, creates a session ID and server nonce, and returns `pair_ok` with the fixed observe/core grants and an HMAC server proof. The addon validates the proof, derives the session key, and sends a signed `pair.ack` containing the proof. The server answers with signed `pair.complete`; the addon clears the token and sends signed `addon.ready` with its identity, version, feature tags, addon hash, and plugin state.

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

Canonical JSON sorts object keys, preserves array order, allows null, booleans, strings, and safe integers only, and rejects floating-point numbers. Godot’s JSON parser represents wire numbers as floats, so the addon accepts only finite integral values within JavaScript’s safe-integer range and renders them as integers for signing.

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

## Limits and closes

- Text frames only; binary frames close with policy violation (`1008`).
- Maximum WebSocket payload: 1 MiB; larger frames close with `1009` and audit `PAYLOAD_TOO_LARGE`.
- A second pending or attached client closes with `1008` and `AUTHENTICATION_FAILED`.
- Pairing has a five-second production timeout and descriptors expire after 60 seconds.
- Server shutdown removes any unconsumed descriptor and closes owned clients idempotently.
