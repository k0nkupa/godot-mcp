# Godot MCP

Godot MCP is an open-source, security-first MCP server and Godot editor addon. Phase 7 provides reversible installation, authenticated Godot 4.7 editor attachment, six default observe-only tools, explicitly gated runtime/input surfaces, permission-scoped editor authoring, native read-only GDScript debugging, and bounded structured performance evidence.

## Requirements

- macOS (the currently certified platform)
- Node.js 22
- pnpm 11.13.0
- Godot 4.7 stable

Compatibility is evidence-gated by `release/compatibility-matrix.json`. Godot 4.4–4.6 and Linux/Windows remain experimental until their exact matrix cells carry trusted certification receipts; pending cells are not advertised as supported.

## Source quick start

```bash
pnpm install --frozen-lockfile
pnpm build
node /absolute/path/to/godot-mcp/packages/cli/dist/bin.js init --project /absolute/path/to/godot-project
node /absolute/path/to/godot-mcp/packages/cli/dist/bin.js doctor --project /absolute/path/to/godot-project
node /absolute/path/to/godot-mcp/packages/cli/dist/bin.js editor --project /absolute/path/to/godot-project
```

For a verified release-to-release replacement, run `godot-mcp upgrade --project /absolute/path/to/godot-project --source /absolute/path/to/new/addons/godot_mcp`. Upgrade and rollback refuse independently modified installed files and preserve the original uninstall preimage.

Use the `editor` command for the Phase 7-certified launch. It writes a short-lived owner-only startup attestation, then starts Godot with the authenticated editor debugger and native DAP assigned to one loopback port; the debugger binds first, so unauthenticated DAP never acquires a listener. The addon consumes the attestation and connects outward only when a matching MCP runtime publishes a short-lived pairing descriptor. Opening the project through another launcher keeps earlier editor features available, but runtime debugging fails closed because secure startup cannot be proven by copied user arguments alone.

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

- `godot_runtime` — launch, bounded runtime queries/control, native GDScript breakpoints/stacks/variables/selector watches, monitor snapshots, and cancellable structured profiles for one authenticated child runtime
- `godot_runtime_capture` — one to eight ordered running-game PNG frames with verified evidence metadata
- `godot_input` — bounded events, frame-indexed sequences, non-passive recording, and deterministic replay for the owned runtime
- `godot_editor` — preview, apply, undo, and redo one bounded scene/node/resource/source authoring batch with durable idempotency and native editor history

For example:

```json
{ "operation": "scene_tree", "scenePath": "res://main.tscn", "maxDepth": 8, "maxNodes": 250 }
{ "viewport": "2d", "maxWidth": 1280, "maxHeight": 720 }
{ "operation": "launch", "scenePath": "res://main.tscn" }
{ "operation": "debug_breakpoints_set", "handle": { "runId": "<run UUID>", "generation": 1 }, "breakpoints": [{ "sourcePath": "res://player.gd", "line": 42 }] }
{ "operation": "profile_start", "handle": { "runId": "<run UUID>", "generation": 1 }, "durationMs": 1000, "intervalFrames": 1, "groups": ["frame", "memory"], "retainRaw": false }
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
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-6
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-7
```

The Phase 7 gate certifies secure shared-port editor startup, native-DAP inertness, authenticated editor-session debugging, breakpoints/stacks/variables/selector watches, bounded public monitor snapshots, completed and cancelled profiles, hostile-input rejection, published stdio behavior, and zero owned-state or fixture residue. Earlier gates remain required regressions. See [Phase 7 testing](docs/testing/phase-7.md), [Phase 6 testing](docs/testing/phase-6.md), the [threat model](docs/security/threat-model.md), and the [bridge protocol](docs/protocol/bridge-v1.md).

## Roadmap

Later phases add declarative playtests, imports/builds/exports, evidence retrieval, compatibility lanes, and explicitly gated disposable-fixture unsafe mode. None of those capabilities are claimed by Phase 7.
