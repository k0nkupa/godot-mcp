# Phase 0–1 certification

The authoritative local gate is:

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-0-1
```

Requirements are Node.js 22, pnpm 11.13.0, and Godot `4.7.stable.official.5b4e0cb0f`. The gate stops at the first failure and runs, in order: generated protocol drift, package builds, ESLint, TypeScript, package unit tests, fixture import, cross-language GDScript crypto, real-editor integrations, adversarial security tests, MCP-stdio/editor E2E, and `git diff --check`.

The E2E uses a disposable copy of `fixtures/godot-4.7`. It initializes the addon, launches a real headless editor, connects through the MCP SDK’s stdio transport, waits for authenticated attachment, verifies the four Phase 1 tools remain present in the current six-tool Phase 2 server, shuts down, disables and uninstalls the addon, then requires a zero diff from the original project. The gate pins its integration, security, and E2E file list so Phase 2's visible-editor certification remains separate.

The hostile matrix covers wrong token, wrong project UUID, changed project hash, expired descriptor, pair replay, sequence replay, oversized and malformed frames, an unauthenticated early connection, a second client, server death, editor transport death, and stale descriptor cleanup. Every rejection checks its stable error, the unchanged `project.godot` digest, an audit receipt, and absence of the actual token and derived key.

macOS CI downloads the official universal Godot 4.7 archive, verifies the pinned SHA-512 before extraction, checks the exact engine build ID, and runs this same command. Security receipts are written to a persistent CI failure-artifact directory, and the E2E copies its audit/editor logs there before disposable-project cleanup when it fails. CI uploads that directory only on failure; pairing descriptors are never copied or uploaded.
