# Phase 0–1 threat model

## Security boundary

Phase 0–1 protects a Godot project from unauthenticated network clients, accidental cross-project attachment, replay, stale messages, and ordinary local clients that do not possess the short-lived pairing secret. It does not defend against a process that has already compromised the same operating-system user. Such a process can read that user’s files or instrument their processes.

The MCP process listens only on IPv4 loopback (`127.0.0.1`). The Godot addon never opens a listener; it reads the descriptor for its exact project identity and connects outward. Loopback is transport containment, not authentication.

## Pairing and session secrets

- The server creates a random 256-bit token and session nonce in an owner-only (`0600`) runtime descriptor.
- The descriptor expires after 60 seconds and is named for the project UUID.
- Pairing validates the token, nonce, protocol and product versions, canonical project identity, `project.godot` hash, addon manifest hash, and Godot 4.7 version.
- Successful pairing consumes the descriptor. Both peers derive a session key from the token and two nonces; the raw token is cleared from the addon.
- Signed messages carry a session ID, strictly increasing sequence, bounded deadline, method, canonical JSON parameters, and HMAC-SHA-256.
- Replays, reordered messages, expired or far-future deadlines, malformed messages, oversized frames, and second clients are rejected and audited.

## Project and host containment

Phase 1 exposes only four observe-tier metadata tools. It exposes no arbitrary filesystem path, host shell, process launcher, network client, GDScript evaluation, generic method invocation, or project mutation tool. Project discovery resolves real paths, rejects symlinked configuration files, and fingerprints `project.godot`. Addon install/uninstall uses a hash manifest and refuses to overwrite or remove independently changed files.

Future project operations must stay inside approved `res://` roots and deny `.git`, secrets, environment files, credentials, OS configuration, and symlink escapes. Those mutation operations are roadmap items, not Phase 1 behavior.

## Audit and redaction

Receipts are append-only JSONL under `.godot/evidence/godot-mcp/`. Audit values recursively redact token-, secret-, key-, password-, credential-, and authorization-shaped fields. Tests build checks from the real pairing token and derived session key to prove neither appears in audit output. Pairing descriptors are never CI artifacts.

## Explicitly out of scope

Unsafe fixture mode is not implemented in Phase 1. When implemented, it will require a disposable registered fixture, separate process, scrubbed environment, short grant, and interactive approval. It will reduce accidental exposure but will not be described as a secure sandbox for hostile code running as the current user.
