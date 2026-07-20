# Phase 11 certification gate

Run:

```bash
GODOT_BIN=/absolute/path/to/godot pnpm qa:phase-11
```

The gate requires the exact engine named by the local matrix cell, generated-protocol consistency, builds, lint, typecheck, the complete serialized test suite, hostile/concurrency/stale-session coverage, install/upgrade/rollback/uninstall, deterministic release construction, independent artifact/hash/version verification, cleanup, and a clean committed diff.

A matrix cell may be changed from `pending` to `certified` only by a trusted CI job that attaches its complete signed receipt to the same source revision. Pending and skipped cells are not advertised. Public npm/GitHub publication and the manual Godot Asset Library submission are downstream of a fully green matrix and are never simulated by this gate.
