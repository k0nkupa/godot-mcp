# Godot MCP

Godot MCP is an open-source, security-first MCP server and Godot editor addon. Phase 0–1 provides reversible addon installation, authenticated attachment to a real Godot 4.7 editor, and four observe-only MCP tools. The broader editor, runtime, input, visual, debugging, mutation, build, and export surface is the approved roadmap—not current functionality.

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

All four tools are read-only and closed-world. Phase 1 has no project mutation, runtime control, input injection, screenshot, debugger, build/export, arbitrary filesystem, shell, or unsafe-evaluation tool.

## Development and certification

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-0-1
```

This gate builds and typechecks every package, runs unit/security/integration/E2E tests against disposable projects and a real Godot editor, checks cross-language cryptography, and verifies cleanup. See [Phase 0–1 testing](docs/testing/phase-0-1.md), the [threat model](docs/security/threat-model.md), the [bridge protocol](docs/protocol/bridge-v1.md), and the [master design](docs/superpowers/specs/2026-07-15-godot-mcp-master-design.md).

## Roadmap

Later phases add runtime launch and inspection, editor and game screenshots, input automation, scene/resource authoring with Undo/Redo, debugger and profiler integration, declarative playtests, imports/builds/exports, compatibility lanes, and explicitly gated disposable-fixture unsafe mode. None of those capabilities are claimed by Phase 1.
