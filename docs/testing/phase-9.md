# Phase 9 project and build operations gate

Phase 9 is certified only by `GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-9` followed by the Phase 0–8 regression gates. A failed or skipped stage is not green.

## Surface and grants

Default sessions remain exactly six observe-only tools. `godot_project` appears only with both `project_operate` and `project`. It accepts strict settings/plugin mutations, import/reimport, run, build, export, and job status/cancel/result operations. It accepts no executable, shell, host path, environment, arbitrary arguments, script, method, or network target.

Settings and plugin changes use UUID idempotency keys, expected preimages, owner-only append journals, hashed receipts, postcondition checks, and rollback. Selective reimport reports `cancellationSafe=false` while Godot's main-thread importer call cannot be interrupted; cancellation remains pending until that boundary completes.

## Jobs and artifacts

Only one project job is active. Tokens are 256-bit opaque values bound to the attached session. Process jobs launch only the configured Godot binary with fixed arguments and a scrubbed environment. PID plus launch fingerprint is journaled; restart recovery signals only an exact match and never signals an ambiguous PID.

Exports require an existing preset whose effective exclusion includes `addons/godot_mcp/**`. Output is allocated beneath `.godot/evidence/godot-mcp/artifacts/<job>/`; existing directories, symlinks, special files, excessive entries/bytes, and containment failures are rejected. Every output is streamed through the MCP marker scanner before an opaque manifest is returned.

The disposable fixture imports, exports a macOS release, scans the archive, unpacks it, launches it without MCP, and requires `PHASE9_STANDALONE_EXPORT_OK`. It never mutates a real game checkout.

## Sixteen stages

1. Exact Godot `4.7.stable.official.5b4e0cb0f`.
2. Generated protocol drift.
3. Topological package builds.
4. ESLint.
5. TypeScript typecheck.
6. Focused protocol/bridge/control-plane/MCP/CLI units.
7. Disposable full import.
8. Disposable GDScript project-operation unit.
9. Mutation and job lifecycle integration.
10. Hostile project-operation matrix.
11. Published stdio E2E.
12. Clean release scan and standalone smoke.
13. Serialized full regressions.
14. Cleanup verification.
15. Committed branch diff check.
16. Working-tree diff and cleanliness.

In restricted environments, record the exact stopping stage. Known examples are pnpm's read-only global cache, denied loopback listeners, and a read-only `.git`; none counts as a pass.
