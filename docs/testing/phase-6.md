# Phase 6 complete authoring certification

Phase 6 extends the existing `godot_editor` transaction surface; it adds no tool, tier, or capability pack. The tool remains visible only with `project_mutate` plus `editor`, while observe-only sessions expose exactly six tools.

## Certified contract

- Resource authoring: stored property/metadata changes, typed resource references, embedded-resource locators, revision checks, and import-metadata expectations without scan or reimport.
- Typed domains: Control layout, Theme items, Animation libraries/tracks/keys and AnimationTree settings, bounded TileMapLayer cells, and structural custom Resource creation.
- Source authoring: `create_script`, `replace_script`, `create_shader`, and `replace_shader` for canonical project-local `.gd`/`.gdshader` files with LF normalization, parse validation, exact replacement hashes, atomic writes, and redacted audit hashes.
- All operations retain Phase 5 preview/digest binding, UUID idempotency, one scene or global native Undo/Redo history, conflict rechecks, exact file preimages, and rollback reporting.
- Global batches compose multiple edits to one resource graph and emit one atomic write per resource path.

## Bounds and exclusions

Requests contain 1–32 steps and at most 256 KiB, touch at most eight files, and retain at most 4 MiB of preimages. Source files are NUL-free UTF-8, at most 192 KiB, and cannot target addons, hidden/protected paths, traversal, symlinks, or host paths. Resource traversal depth is eight; general collections are 256 entries; packed arrays and tile coordinates are capped at 4,096.

Phase 6 does not execute authored source, arbitrary methods, expressions, shell commands, host filesystem access, network requests, project settings, plugins, scan/reimport, builds, exports, or unsafe mode. Imports/builds/exports remain later phases.

## Gate

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-6
```

The 15-stage macOS gate pins Godot `4.7.stable.official.5b4e0cb0f`; runs build, lint, typecheck, focused contracts, disposable import and four Godot units, authenticated integration, hostile inputs, published stdio, the serialized full Vitest suite, generated-protocol and cleanup checks, and committed/working-tree diff checks. Phase 0–1 through Phase 5 gates remain required regressions.
