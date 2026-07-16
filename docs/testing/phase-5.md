# Phase 5 editor mutation certification

Phase 5 adds one explicitly authorized `godot_editor` tool. It is visible only when the session grants both `project_mutate` and the `editor` pack; the default surface remains exactly six observe-only tools.

## Certified contract

- `preview` is side-effect free and returns the SHA-256 plan digest required by `apply`.
- `apply`, `undo`, and `redo` require UUID idempotency keys. Completed requests replay from the owner-only mutation journal; a crash-left unknown outcome returns `CONFLICT` instead of repeating the mutation.
- One batch contains 1–32 steps, is at most 256 KiB, touches at most eight project files, retains at most 4 MiB of preimages, and resolves to one open-scene history or the global file history.
- Scene operations cover bounded node creation, duplication, ordering, rename, reparent, deletion, properties, metadata, groups, signals, and ownership.
- Project-file operations cover scene/resource create, duplicate, move, and delete with precondition rechecks, atomic same-directory replacement, protected-path denial, and exact byte restoration.
- Native `EditorUndoRedoManager` owns every action. MCP undo/redo is action-scoped and refuses to consume an intervening human action.
- Receipts include target identities, preconditions, changes, partial-effect state, rollback outcome, warnings, and safe recovery. Audit records hash idempotency keys and omit sensitive values.

## Bounds and exclusions

Paths must be canonical project-local `res://` scene/resource paths. Absolute paths, traversal, subnames, `.git`, addons, unauthorized `.godot`, environment/credential names, and symlink escapes are rejected. Engine classes must exist, be instantiable, and match the requested Node/Resource base; resource creation uses a narrow allowlist.

Phase 5 does not author scripts, shaders, imported assets, project settings/imports, builds/exports, runtime state, debugger state, shell commands, host files, network requests, arbitrary methods, or evaluated GDScript.

## Gate

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-5
```

The 13-stage macOS gate pins Godot `4.7.stable.official.5b4e0cb0f` and covers builds, lint, typecheck, package tests, disposable import, GDScript mutation units, contracts/ledger/tool grants, authenticated editor integration, hostile inputs, published stdio, the full regression suite, and diff checks. Phase 0–1 through Phase 4 gates remain required regressions before release.
