# Phase 2 certification

The authoritative Phase 2 gate is:

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-2
```

It requires macOS with a visible WindowServer session, Node.js 22, pnpm 11.13.0, and exactly Godot `4.7.stable.official.5b4e0cb0f`. The gate fails on other platforms rather than substituting headless captures.

The 13 ordered stages check generated protocol drift; topological builds; ESLint; TypeScript; package tests; disposable fixture import; cross-language protocol crypto; the GDScript observation harness; real-editor query truth; visible 2D/3D captures; the security matrix; published MCP-stdio E2E; and `git diff --check`. `qa:phase-0-1` remains a separate pinned regression gate for installation, pairing, lifecycle, hostile attachment, and cleanup.

## Why captures are visible

Godot exposes a real rendered 2D or 3D editor viewport only when that main editor screen has completed layout. The capture tests therefore open an explicit scene in a visible macOS editor. They never switch screens through the addon. Query-only, protocol, hostile-input, and lifecycle tests remain headless where rendering is irrelevant. Every editor test uses an isolated copy of `fixtures/godot-4.7`; no real game checkout is mutated.

## Certified surface

`godot_query` supports six variants:

- `editor_state`: open/edited/unsaved scenes, selection, and filesystem scan/import state.
- `scene_tree`: an already-open scene, bounded to depth 32 and 1,000 nodes.
- `node`: identity, groups, signals, script/resource references, and up to 128 encoded properties; secret-shaped property names have redacted values.
- `resources`: sorted `EditorFileSystem` metadata, paged to at most 2,000 records with at most 10,000 indexed entries scanned per request.
- `project_settings`: paged values under approved namespaces with secret-shaped names omitted.
- `diagnostics`: sequence-pageable, path/token-redacted records from a 500-entry ring.

`godot_capture` accepts the current `2d` viewport or `3d` viewport index 0–3, dimensions up to 2048×2048, PNG only, and at most 8 MiB decoded across 16 signed chunks. The MCP result includes a real image content block. Structured output includes the byte length, SHA-256, dimensions, and opaque evidence URI; the content-addressed PNG and metadata are stored under `.godot/evidence/godot-mcp/sessions/<session-id>/`.

Acceptance decodes both fixture PNGs, requires dimensions above the placeholder size and multiple colors, verifies requested maximum dimensions and SHA-256, confirms the evidence bytes match, and ensures image base64 never appears in structured output or audit JSONL. Query tests compare open scenes, nodes, groups, signals, resource references, settings, and diagnostics to fixture truth. Shutdown, disable, uninstall, descriptor cleanup, and zero project diff are required.

On failure, the configured `GODOT_MCP_FAILURE_ARTIFACT_DIR` retains audit JSONL, editor/MCP stderr logs, and metadata-only structured receipts. It never receives pairing descriptors, session secrets, or raw/base64 PNG data.

## Phase 2 limitations

Only already-open scenes and indexed resource metadata are readable. Phase 2 returns no script source or arbitrary file contents and provides no runtime bridge, game capture, input, selection change, scene/resource mutation, debugger, profiler, import, build, export, shell, network, unsafe evaluation, or evidence-retrieval tool. Those remain later-phase work.
