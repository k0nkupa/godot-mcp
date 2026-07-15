# Godot MCP contributor guide

## Start here

- Product contract: `docs/superpowers/specs/2026-07-15-godot-mcp-master-design.md`
- Current implementation plan: `docs/superpowers/plans/2026-07-16-phase-3-ephemeral-runtime-bridge.md`
- Security boundary: `docs/security/threat-model.md`
- Wire contract: `docs/protocol/bridge-v1.md`
- Phase gate: `docs/testing/phase-3.md`

## Guardrails

- Keep MCP on stdio and bind the Godot bridge only to `127.0.0.1`; the addon opens no listener.
- Treat loopback as containment, not authentication. Preserve one-use descriptors, signed envelopes, sequence/deadline checks, project identity, and audit redaction.
- Do not add arbitrary shell, host filesystem, network, method invocation, or GDScript evaluation to normal profiles.
- Default sessions expose exactly six observe-only tools. Phase 3 adds exactly two runtime tools only with explicit `runtime_control` tier and `runtime` pack grants.
- Use disposable fixture copies for editor, destructive, hostile-input, and E2E work. Do not test mutations directly in a real game checkout.
- Preserve reversible, manifest-verified addon installation and refuse independently changed files.

## Validation

Use focused Vitest tests while developing. Before claiming Phase 3 complete, run `GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-3`, then the Phase 0–1 and Phase 2 regression gates. Never claim a skipped check passed.
