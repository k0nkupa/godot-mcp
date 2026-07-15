# Godot MCP

Godot MCP is an open-source, security-first MCP server and Godot editor addon. Phase 3 provides reversible installation, authenticated Godot 4.7 editor attachment, six default observe-only tools, and an explicitly authorized two-tool ephemeral runtime surface. Runtime input, editor mutation, debugger stacks, builds, exports, and unsafe evaluation remain roadmap capabilities.

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

The default registration remains observe-only. To opt into one MCP-owned instrumented runtime, explicitly grant both its tier and pack:

```bash
codex mcp add godot-runtime -- node /absolute/path/to/godot-mcp/packages/cli/dist/bin.js connect --project /absolute/path/to/godot-project --grant runtime_control --pack runtime
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

The default six tools are read-only and closed-world. A runtime-authorized session additionally exposes:

- `godot_runtime` — launch, status, bounded tree/node/log queries, waits, pause, step, resume, and stop for one authenticated child runtime
- `godot_runtime_capture` — one to eight ordered running-game PNG frames with verified evidence metadata

For example:

```json
{ "operation": "scene_tree", "scenePath": "res://main.tscn", "maxDepth": 8, "maxNodes": 250 }
{ "viewport": "2d", "maxWidth": 1280, "maxHeight": 720 }
{ "operation": "launch", "scenePath": "res://main.tscn" }
```

Runtime control is off unless both explicit flags are present. The server owns one exact Godot child process, authenticates its debugger harness with a one-use descriptor, binds it to the MCP/editor/project/run identity, and accepts only closed typed operations. It exposes no arbitrary process, filesystem, network, method-call, or GDScript-evaluation primitive.

## Development and certification

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-0-1
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-2
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-3
```

The Phase 3 gate certifies explicit tool visibility, owned-process authentication, bounded runtime truth, deterministic stepping, running-game evidence, hostile inputs, crash/disconnect cleanup, published stdio behavior, and zero fixture diff. Earlier gates remain required regressions. See [Phase 3 testing](docs/testing/phase-3.md), [Phase 2 testing](docs/testing/phase-2.md), [Phase 0–1 testing](docs/testing/phase-0-1.md), the [threat model](docs/security/threat-model.md), the [bridge protocol](docs/protocol/bridge-v1.md), and the [master design](docs/superpowers/specs/2026-07-15-godot-mcp-master-design.md).

## Roadmap

Later phases add input automation, scene/resource authoring with Undo/Redo, debugger stacks and profiler integration, declarative playtests, imports/builds/exports, evidence retrieval, compatibility lanes, and explicitly gated disposable-fixture unsafe mode. None of those capabilities are claimed by Phase 3.
