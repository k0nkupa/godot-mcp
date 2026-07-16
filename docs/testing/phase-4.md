# Phase 4 certification

Run the authoritative gate with:

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-4
```

The gate requires macOS, Node.js 22, pnpm 11.13.0, a WindowServer session, and exactly Godot `4.7.stable.official.5b4e0cb0f`. Its 14 ordered stages cover protocol drift, builds, lint, typecheck, package tests, disposable import, GDScript input/harness units, protocol/control-plane/MCP contracts, the authenticated real-runtime fixture, hostile inputs and late results, cleanup recovery, built stdio acceptance, the full regression suite, and branch/working-tree diff checks. Failure-only artifacts are redacted and removed after a full pass.

## Authorized surface

Default sessions still expose exactly six observe/core tools. `--grant runtime_control --pack runtime` adds the two Phase 3 runtime tools. `--grant runtime_control --pack input` adds only `godot_input`; a practical launch-and-input session therefore uses both packs and exposes exactly nine tools:

```bash
godot-mcp connect --project /absolute/project --grant runtime_control --pack runtime --pack input
```

`godot_input` accepts only `send`, `sequence`, `record_start`, `record_stop`, and `replay`. The closed event union is action, key, mouse button/motion/scroll, touch/drag, pan/magnify, and joypad button/motion. It has no arbitrary class, property, method, text, OS-global input, editor-input, filesystem, network, shell, or evaluation path.

Sequences and traces contain at most 256 events, nondecreasing offsets 0–1,800, and deadlines no longer than 30 seconds. Floating wire values are represented as fixed-point integer millionths. Positional input targets only `.` or a relative descendant `Viewport`; normalized coordinates are integer millionths, while viewport/embedder coordinates are bounded pixels.

## Deterministic replay

Realtime sequences are explicitly non-deterministic. Replay and deterministic sequences require an already paused owned runtime. Frame offsets are zero-based: events scheduled at offsets 0–2 are processed across exactly three rendered frames, and the runtime remains paused. Reproducible comparisons pin project revision, Godot version, scene, viewport size, renderer, locale, seed, and time-step settings.

Recording is non-passive: it captures only successfully injected MCP events, never ambient hardware input. Receipts contain event kinds/counts, scheduled/delivered offsets, coordinate-space metadata, release kinds, deterministic/recording state, and a canonical trace SHA-256. Audit JSONL stores only a summary and digest, not action names, keycodes, coordinates, or trace payloads.

Held MCP state is neutralized on timeout/error when reachable, scene replacement, runtime stop/exit, debugger loss, and owner shutdown. Scene-replacement tests prove held reload keys are released before the replacement fixture starts. All editor/runtime/E2E checks use disposable fixture copies and require zero project diff and no remaining descriptors or leases.

Phase 0–1, Phase 2, and Phase 3 gates remain mandatory release regressions.
