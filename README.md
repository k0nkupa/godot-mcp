# Godot MCP

Godot MCP is an open-source, security-first MCP server and Godot editor addon. Phase 4 provides reversible installation, authenticated Godot 4.7 editor attachment, six default observe-only tools, an explicitly authorized two-tool ephemeral runtime surface, and one separately gated runtime-input tool.

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
```

The Phase 4 gate additionally certifies the closed input union, coordinate routing, deterministic record/replay parity, hostile input rejection, audit redaction, release cleanup, exact nine-tool stdio surface, and zero fixture diff. Earlier gates remain required regressions. See [Phase 4 testing](docs/testing/phase-4.md), [Phase 3 testing](docs/testing/phase-3.md), [Phase 2 testing](docs/testing/phase-2.md), [Phase 0–1 testing](docs/testing/phase-0-1.md), the [threat model](docs/security/threat-model.md), the [bridge protocol](docs/protocol/bridge-v1.md), and the [master design](docs/superpowers/specs/2026-07-15-godot-mcp-master-design.md).

## Roadmap

Later phases add scene/resource authoring with Undo/Redo, debugger stacks and profiler integration, declarative playtests, imports/builds/exports, evidence retrieval, compatibility lanes, and explicitly gated disposable-fixture unsafe mode. None of those capabilities are claimed by Phase 4.
