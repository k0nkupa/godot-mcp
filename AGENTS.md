# Godot MCP contributor guide

## Start here

- Product contract: `docs/superpowers/specs/2026-07-15-godot-mcp-master-design.md`
- Current implementation plan: `docs/superpowers/plans/2026-07-17-phase-7-debugging-performance.md`
- Security boundary: `docs/security/threat-model.md`
- Wire contract: `docs/protocol/bridge-v1.md`
- Phase gate: `docs/testing/phase-7.md`

## Guardrails

- Keep MCP on stdio and bind the Godot bridge only to `127.0.0.1`; the addon opens no listener.
- Treat loopback as containment, not authentication. Preserve one-use descriptors, signed envelopes, sequence/deadline checks, project identity, and audit redaction.
- Do not add arbitrary shell, host filesystem, network, method invocation, or GDScript evaluation to normal profiles.
- Default sessions expose exactly six observe-only tools. Runtime adds two tools with explicit `runtime_control` plus `runtime`; input adds exactly one tool with explicit `runtime_control` plus `input`.
- Use disposable fixture copies for editor, destructive, hostile-input, and E2E work. Do not test mutations directly in a real game checkout.
- Preserve reversible, manifest-verified addon installation and refuse independently changed files.

## Validation

Use focused Vitest tests while developing. Before claiming Phase 7 complete, run `GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-7`, then the Phase 0–1 and Phase 2–6 regression gates. Never claim a skipped check passed.
