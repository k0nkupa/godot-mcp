# Godot MCP

Godot MCP is an open-source, security-first MCP server and Godot editor addon. Phase 5 provides reversible installation, authenticated Godot 4.7 editor attachment, six default observe-only tools, explicitly gated runtime/input surfaces, and one permission-scoped editor mutation tool with native Undo/Redo.

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

To launch and automate the owned runtime, grant the input pack separately:

```bash
codex mcp add godot-runtime-input -- node /absolute/path/to/godot-mcp/packages/cli/dist/bin.js connect --project /absolute/path/to/godot-project --grant runtime_control --pack runtime --pack input
```

To preview and apply bounded editor mutations, explicitly grant both the mutation tier and editor pack:

```bash
codex mcp add godot-editor -- node /absolute/path/to/godot-mcp/packages/cli/dist/bin.js connect --project /absolute/path/to/godot-project --grant project_mutate --pack editor
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
- `godot_input` — bounded events, frame-indexed sequences, non-passive recording, and deterministic replay for the owned runtime
- `godot_editor` — preview, apply, undo, and redo one bounded scene/node/resource mutation batch with durable idempotency and native editor history

For example:

```json
{ "operation": "scene_tree", "scenePath": "res://main.tscn", "maxDepth": 8, "maxNodes": 250 }
{ "viewport": "2d", "maxWidth": 1280, "maxHeight": 720 }
{ "operation": "launch", "scenePath": "res://main.tscn" }
{ "operation": "sequence", "handle": { "runId": "<run UUID>", "generation": 1 }, "mode": "deterministic", "events": [{ "frameOffset": 0, "event": { "type": "action", "action": "jump", "pressed": true, "strengthMillionths": 1000000 } }, { "frameOffset": 1, "event": { "type": "action", "action": "jump", "pressed": false, "strengthMillionths": 0 } }] }
```

Runtime control and input are off unless their explicit flags are present. Deterministic sequences/replay require a paused owned runtime; offsets are zero-based, so offsets 0–1 process across two rendered frames and leave it paused. Recording captures only MCP-injected events. Receipts and audit summaries omit raw action names, keycodes, coordinates, and trace payloads. There is no OS-global/editor input, arbitrary text, process, filesystem, network, method-call, or GDScript-evaluation primitive.

## Development and certification

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-0-1
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-2
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-3
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-4
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-5
```

The Phase 5 gate certifies explicit tool exposure, preview/apply digest binding, idempotent replay, save/reload persistence, action-scoped Undo/Redo, protected-path rejection, rollback reporting, stdio cleanup, and zero fixture diff. Earlier gates remain required regressions. See [Phase 5 testing](docs/testing/phase-5.md), [Phase 4 testing](docs/testing/phase-4.md), the [threat model](docs/security/threat-model.md), the [bridge protocol](docs/protocol/bridge-v1.md), and the [master design](docs/superpowers/specs/2026-07-15-godot-mcp-master-design.md).

## Roadmap

Later phases add script/shader authoring, debugger stacks and profiler integration, declarative playtests, imports/builds/exports, evidence retrieval, compatibility lanes, and explicitly gated disposable-fixture unsafe mode. None of those capabilities are claimed by Phase 5.
