# Godot MCP bridge protocol v1

The Phase 1 bridge is JSON over a loopback WebSocket at `ws://127.0.0.1:<ephemeral-port>/bridge`. The server writes the address and one-use authentication material to an owner-only runtime descriptor. The addon initiates the connection; it opens no port.

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

## Limits and closes

- Text frames only; binary frames close with policy violation (`1008`).
- Maximum WebSocket payload: 1 MiB; larger frames close with `1009` and audit `PAYLOAD_TOO_LARGE`.
- A second pending or attached client closes with `1008` and `AUTHENTICATION_FAILED`.
- Pairing has a five-second production timeout and descriptors expire after 60 seconds.
- Server shutdown removes any unconsumed descriptor and closes owned clients idempotently.
