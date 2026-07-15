# Godot MCP

Godot MCP is an open-source, security-first MCP server and Godot editor addon. Phase 2 provides reversible addon installation, authenticated attachment to a real Godot 4.7 editor, bounded editor observation, and real 2D/3D editor viewport PNGs through six observe-only MCP tools. Runtime, input, debugging, mutation, build, export, and unsafe execution remain roadmap capabilities—not current functionality.

## Requirements

- macOS (the currently certified platform)
- Node.js 22
- pnpm 11.13.0
- Godot 4.7 stable

## Source quick start

```bash
pnpm install --frozen-lockfile
pnpm build
node /absolute/path/to/godot-mcp/packages/cli/dist/bin.js init --project /absolute/path/to/godot-project
node /absolute/path/to/godot-mcp/packages/cli/dist/bin.js doctor --project /absolute/path/to/godot-project
```

Open the project in Godot after `init`. The addon connects outward only when a matching MCP runtime publishes a short-lived pairing descriptor.

Register the source checkout with Codex using absolute paths:

```bash
codex mcp add godot -- node /absolute/path/to/godot-mcp/packages/cli/dist/bin.js connect --project /absolute/path/to/godot-project
```

Start a fresh Codex task after registration so the newly registered MCP server is exposed. To stop using the addon while retaining its files, or remove the verified installation completely:

```bash
node /absolute/path/to/godot-mcp/packages/cli/dist/bin.js disable --project /absolute/path/to/godot-project
node /absolute/path/to/godot-mcp/packages/cli/dist/bin.js uninstall --project /absolute/path/to/godot-project
```

Uninstall refuses to remove the addon, project configuration, or `project.godot` if they changed independently after installation.

## Implemented MCP tools

- `godot_session` — attachment, project identity, versions, and grants
- `godot_capabilities` — currently visible observe/core capabilities
- `godot_doctor` — installation, plugin, identity, and attachment diagnostics
- `godot_help` — built-in usage and security-boundary help
- `godot_query` — bounded editor state, open scene/tree/node metadata, indexed resources, approved project settings, and redacted diagnostics
- `godot_capture` — bounded PNG from the current 2D or selected 3D editor viewport, returned as MCP image content and persisted as session evidence

All six tools are read-only and closed-world. For example:

```json
{ "operation": "scene_tree", "scenePath": "res://main.tscn", "maxDepth": 8, "maxNodes": 250 }
{ "viewport": "2d", "maxWidth": 1280, "maxHeight": 720 }
```

Queries inspect only already-open scenes and EditorFileSystem-indexed metadata; they never return script source or arbitrary file bytes. Capture is PNG-only and does not switch editor screens. Phase 2 has no project mutation, runtime control, input injection, debugger, build/export, arbitrary filesystem, shell, network, generic method invocation, or unsafe-evaluation tool.

## Development and certification

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-0-1
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-2
```

The Phase 0–1 gate preserves the attachment and lifecycle baseline. The Phase 2 gate additionally certifies query truth, visible 2D/3D captures, chunk integrity, hostile observation bounds, MCP image delivery, audit redaction, and clean uninstall. See [Phase 2 testing](docs/testing/phase-2.md), [Phase 0–1 testing](docs/testing/phase-0-1.md), the [threat model](docs/security/threat-model.md), the [bridge protocol](docs/protocol/bridge-v1.md), and the [master design](docs/superpowers/specs/2026-07-15-godot-mcp-master-design.md).

## Roadmap

Later phases add runtime launch and inspection, game screenshots, input automation, scene/resource authoring with Undo/Redo, debugger and profiler integration, declarative playtests, imports/builds/exports, evidence retrieval, compatibility lanes, and explicitly gated disposable-fixture unsafe mode. None of those capabilities are claimed by Phase 2.
