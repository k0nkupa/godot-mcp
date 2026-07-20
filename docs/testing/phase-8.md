# Phase 8 testing and visual QA certification

Phase 8 adds one declarative `godot_visual` tool. It is registered only when a session has `runtime_control` and all three `runtime`, `input`, and `visual` packs. Observe-only sessions remain exactly six tools; runtime adds two; input adds one; a complete visual session adds one more. Partial visual grants expose nothing.

## Certified surface

- `baseline_create` copies a verified current-session PNG observation into an immutable project-local named baseline. Repeating the same name and digest is idempotent; changing the digest is a conflict.
- `baseline_get` returns the bounded manifest without a host path.
- `compare` performs deterministic RGBA comparison against a verified observation. It supports one bounded region, up to 64 rectangular masks, an inclusive per-channel delta, and simultaneous maximum different-pixel and ratio-millionths limits.
- `scenario_start`, `scenario_status`, `scenario_cancel`, and `scenario_result` manage one session-bound job with an opaque 256-bit token. Jobs contain at most 64 serial steps and 512 KiB, run for at most 120 seconds, and always attempt to stop the runtime generation they launched.
- Scenarios use only the existing closed runtime, input, and capture contracts. They cannot evaluate code, invoke arbitrary methods, select host paths, issue shell commands, or open sockets.

PNG inputs are limited to eight MiB, 2048×2048, and 4,194,304 pixels. JSON evidence is limited to one MiB. Every observation is session-bound and digest-verified on read. Baseline names are 1–64 safe ASCII characters; manifests and bytes must be regular non-symlink files. Report digests cover the canonical terminal report while excluding the digest and observation URI fields.

For each compared pixel, the comparator takes the maximum absolute delta across RGBA. A pixel differs when that value is greater than `maxChannelDelta`. A result passes only when both `differentPixels <= maxDifferentPixels` and `floor(differentPixels * 1_000_000 / comparedPixels) <= maxDifferentRatioMillionths`. Masked pixels are excluded from both numerator and denominator. Failed comparisons remain ordinary visual results and retain current-frame, red-diff, and comparison-report evidence.

Launch determinism is pinned inside the authenticated one-use runtime descriptor: runtime-window width/height, fixed renderer, locale, signed 32-bit seed, and fixed FPS. The harness attests the observed window size controlled by `--resolution`, applies the seed before scene load, and reports the remaining observed pins. Project stretch settings may use different logical canvas coordinates. These controls reduce variance; they do not claim cross-machine rendering identity.

Audit records contain operation names, hashed scenario/baseline names, step-kind counts, and evidence observation URIs. They exclude input values/unicode, property values, log text, PNG bytes, caller paths, and raw scenario documents.

## Realistic acceptance

When `/Users/tony/Projects/town-building-game` exists at the pinned source commit, acceptance records its `HEAD`, NUL-delimited working-tree status digest, and index digest; materializes `git archive HEAD` into a disposable directory; and installs the addon only in that archive. The archive uses a unique custom Godot user-data directory. An acceptance-only script exercises the project's real save/domain classes to create a deterministic developed town with four buildings, 18 residents, and fixed progression state.

The normal gate never creates its own oracle. It waits for 30 rendered frames within a 30-second readiness bound, requires no error logs, pauses the runtime, captures the 1280×720 frame, and compares it with the human-approved repository baseline. The comparison allows channel delta 4 and at most 1% changed pixels. Refresh mode (`GODOT_MCP_UPDATE_TOWN_BASELINE=1`) writes a candidate bundle and deliberately fails until a human visually approves the candidate and installs its exact PNG and metadata. Both modes remove the disposable project and custom user data, and the source checkout must have identical recorded state after success or failure.

## Gate

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-8
```

The 16-stage macOS gate pins Godot `4.7.stable.official.5b4e0cb0f`; checks generated protocol drift; builds, lints, and typechecks; runs focused TypeScript units; imports a disposable fixture; runs the visual and pinned-harness GDScript units with mandatory markers and script-error scanning; runs authenticated integration, hostile, published stdio, and isolated town acceptance; runs the full serialized regression suite; verifies cleanup; and requires clean committed and working-tree diffs.

In the current restricted session, authenticated integration/E2E/acceptance cannot bind `127.0.0.1`, and `.git` is read-only. Those environmental stages are recorded as failed or skipped, never passed. The fixture unit and non-network TypeScript checks remain authoritative for what they cover.
