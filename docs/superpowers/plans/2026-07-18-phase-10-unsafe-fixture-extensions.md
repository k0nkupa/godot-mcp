# Phase 10 Unsafe Fixture Mode and Extensions Implementation Plan

> Execute inline in this session. Follow red-green-refactor and preserve every environmental skip honestly.

**Goal:** Add fixture-only, second-factor, short-lived unsandboxed GDScript jobs and a typed extension SDK that remains inside authorization/audit routing.

## Tasks

1. Add strict unsafe registration, marker, activation lease, operation/job schemas, `unsafe_fixture + unsafe` policy, exact tool-count tests, and capability warnings.
2. Implement owner-only no-follow registry/marker/lease stores with canonical identity, one-use consumption, five-minute expiry, and mismatch tests.
3. Add CLI-only register/copy/approve/startup activation workflows; no MCP route may mint a factor.
4. Implement the fixed separate unsafe Godot process with isolated HOME/config/cache, exact PID fingerprint, output cap, deadline, cancellation, and cleanup.
5. Implement one active unsafe job service with opaque tokens, protected output evidence, source deletion, expiry revocation, export conflict, and crash recovery.
6. Register exactly one `godot_unsafe_fixture` tool only after all five factors validate; audit only hashes/counts and label every result `unsafe: true, sandboxed: false`.
7. Build the extension SDK registry, frozen least-authority context, one `godot_extension` tool, schema validation, startup allowlisting, authorization/audit routing, and hostile extension tests.
8. Add disposable unsafe fixture scripts and tests for ordinary-project denial, factor mismatch, lease replay/expiry, arbitrary code execution, timeout/cancel/crash, residue, secret/output audit, and export conflict.
9. Document protocol/threat model and add the 16-stage Phase 10 gate plus cleanup verifier.
10. Inline-review factor isolation, no-follow storage, process ownership, expiry races, audit/source leakage, extension context escape, normal-project reachability, and cleanup; run autoreview if bundle validation permits.

Phase 10 is green only with a clean gate/review. Environmental failures remain explicit and use the standing progression override without being called green.
