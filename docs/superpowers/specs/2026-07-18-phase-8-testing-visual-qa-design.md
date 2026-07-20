# Phase 8 Testing and Visual QA Design

**Status:** Approved by standing user autoapproval; Phase 0–6 regression rerun explicitly skipped because this session denies loopback listeners

**Date:** 2026-07-18

## 1. Purpose

Phase 8 adds bounded declarative playtest scenarios and deterministic visual comparison to authenticated MCP-owned runtimes. A scenario can launch one scene, wait for eventual conditions, assert bounded runtime state, inject an existing certified input trace, capture frames, compare those frames with named baselines, and return a structured report with content-addressed evidence.

The phase adds no general evaluator, arbitrary method call, caller-selected host path, or new Godot listener. The TypeScript control plane owns orchestration, cancellation, baseline storage, comparison, evidence, and audit. Godot continues to expose only the typed runtime, input, and capture operations certified in earlier phases.

## 2. Public surface and authorization

Default sessions continue to expose exactly six observe-only tools. Runtime continues to add exactly `godot_runtime` and `godot_runtime_capture` with `runtime_control` plus `runtime`; input continues to add exactly `godot_input` with `runtime_control` plus `input`.

Phase 8 adds one tool, `godot_visual`, only when all of these grants are present:

- permission tier `runtime_control`;
- capability packs `runtime`, `input`, and `visual`.

The tool has a closed discriminated union of operations:

- `baseline_create`: promote a PNG observation from the attached session into a named project-local baseline;
- `baseline_get`: return bounded baseline metadata without host paths;
- `compare`: compare a current PNG observation with a named baseline;
- `scenario_start`: start one asynchronous scenario job;
- `scenario_status`: return job state and bounded progress;
- `scenario_cancel`: cooperatively cancel the job and stop only its owned runtime;
- `scenario_result`: return the terminal report and evidence references.

No caller supplies an absolute path. Baseline names are ASCII slugs of 1–64 characters. Evidence inputs are exact `godot-mcp://evidence/<sha256>/observations/<uuid>` references owned by the currently attached session.

## 3. Control-plane components

### 3.1 Visual evidence store

`EvidenceStore` gains verified read access for current-session PNG observations and project-local baseline operations. Baselines live below `.godot/evidence/godot-mcp/baselines/<slug>/`; each contains content-addressed PNG bytes and a canonical manifest recording the digest, dimensions, creation time, source observation digest, and comparison-contract version. Files are owner-only and written atomically. Existing baselines are never silently replaced: creating the same name with different bytes returns `CONFLICT`.

Comparison reports and diff PNGs remain session-scoped evidence. `EvidenceStore` adds canonical JSON evidence capped at one MiB alongside its existing eight-MiB PNG limit. API results expose evidence URIs and bounded metadata, never filesystem paths.

### 3.2 Pixel comparison

The comparison engine decodes bounded PNGs with `pngjs`, rejects malformed images and dimension mismatches, and compares RGBA bytes in a selected rectangular region. Zero or more rectangular masks exclude known dynamic areas. Regions and masks use integer pixels, must be inside both images, cannot overlap the image boundary, and are capped at 64 masks.

Tolerance is explicit:

- `maxChannelDelta`: integer 0–255;
- `maxDifferentPixels`: integer 0–4,194,304;
- `maxDifferentRatioMillionths`: integer 0–1,000,000.

A pixel differs when any unmasked RGBA channel exceeds `maxChannelDelta`. A comparison passes only when both different-pixel limits pass. The result includes compared, masked, and different pixel counts; ratio millionths; maximum observed channel delta; baseline/current digests; settings; and a canonical result digest. Failure produces a bounded red-highlight diff PNG and a JSON report as evidence.

### 3.3 Scenario job runner

One `ScenarioService` owns at most one active scenario per MCP server. Jobs are in memory, opaque-token addressed, session-bound, and have the states `queued`, `running`, `completed`, `failed`, and `cancelled`. Terminal reports remain available until the session closes or a later job replaces them. The service accepts an `AbortSignal`; cancellation stops only the runtime handle launched by that job and never kills by process name.

The service depends on narrow interfaces for runtime launch/execute/capture, input delivery, visual comparison, and a monotonic clock. This keeps orchestration unit-testable without adding test-only behavior to production classes.

## 4. Declarative scenario contract

A scenario contains:

- `name`: ASCII slug, 1–64 characters;
- `scenePath`: contained `res://` `.tscn` path;
- `startupTimeoutMs`: 1,000–30,000;
- `deadlineMs`: 1,000–120,000;
- `pins`: runtime-window width and height, renderer (`gl_compatibility` or `mobile`), locale, integer seed, and fixed FPS from the certified set `30`, `60`, or `120`;
- `steps`: 1–64 closed-union steps.

Supported steps are:

- `wait`: reuse the Phase 3 bounded eventual-condition contract;
- `assert`: evaluate `node_exists`, `node_missing`, `property_equals`, `property_matches`, `log_matches`, or `no_error_logs` once;
- `control`: issue `pause`, `resume`, or a bounded 1–120-frame `step` through the existing runtime contract;
- `input`: deliver 1–256 Phase 4 input-trace events, with deterministic mode requiring the runtime to be paused;
- `capture`: capture 1–8 frames using the existing bounded runtime capture contract;
- `compare`: compare one captured frame with a named baseline and explicit region, masks, and tolerances.

Steps reference earlier capture outputs only by a scenario-local label. Labels are unique ASCII slugs. The complete declaration is limited to 512 KiB. Unknown fields and operations fail schema validation.

The runner launches the scene with the requested pins included in the authenticated runtime descriptor and fixed engine arguments. It then executes steps serially. Every step records index, kind, state, start/end monotonic milliseconds, bounded summary, and evidence URIs. The first failed assertion, timeout, comparison, transport error, or cancellation stops later steps. The runner always attempts owned-runtime cleanup; cleanup failure is reported separately and cannot turn a failed scenario into a pass.

## 5. Reports and audit

The terminal scenario report records:

- schema and comparison-contract versions;
- job token, scenario name, project identity, scene, and runtime generation;
- declared pins and observed Godot version;
- terminal state and failed-step index;
- step receipts and evidence observation URIs;
- total monotonic duration;
- cleanup outcome;
- canonical SHA-256 over the report without its digest field.

Audit records include operation, scenario name digest, step counts by kind, terminal state, failed-step index, evidence digests, duration, and cleanup outcome. They exclude input text/unicode, property values, log contents, PNG bytes, host paths, and baseline filesystem locations.

## 6. Determinism and limitations

Pinned settings reduce variance but do not turn arbitrary games into deterministic simulations. The report distinguishes declared pins from observations. Visual comparison is exact according to the declared pixel contract; it does not use perceptual AI, OCR, or machine-dependent quality scoring.

Scenario baselines are explicit approvals. Missing baselines fail with `PRECONDITION_FAILED`; a scenario never creates or updates a baseline implicitly. Baseline replacement, deletion, and bulk acceptance are outside Phase 8.

## 7. Failure and recovery

- Invalid declarations fail before launch with `INVALID_REQUEST`.
- Missing or cross-session observations fail with `STALE_HANDLE` or `PATH_DENIED`.
- Oversized or malformed PNGs fail with `PAYLOAD_TOO_LARGE` or `INVALID_REQUEST`.
- A second active scenario fails with `CONFLICT`.
- Deadline expiry fails with `TIMEOUT` and triggers owned-runtime cleanup.
- Cancellation is terminal and idempotent.
- Runtime disconnect or owner death fails the active job and preserves the bounded report gathered so far.
- Baseline and report writes are atomic; partial temporary files are removed.

## 8. Fixture and realistic acceptance

The Godot 4.7 fixture adds a deterministic visual scene with stable color blocks, a masked animated region, input-driven state, and primitive properties. Tests prove:

1. repeated pinned scenarios return the same behavioral report shape and matching frame digest;
2. an intentional property change fails at the exact assertion with useful evidence;
3. an intentional visual change fails with counts, digests, and a diff PNG;
4. tolerance, region, and mask boundaries pass and fail at exact limits;
5. cancellation, deadline, disconnect, stale token, hostile declaration, and cleanup paths are bounded;
6. earlier tool-count and permission invariants remain exact.

Initial `town-building-game` acceptance uses `git archive HEAD` to create a disposable checkout, installs the addon only into that copy, runs a pinned smoke scenario twice, and compares captured evidence. The source checkout is read-only. The gate records source `HEAD`, porcelain status digest, and tracked-tree digest before and after, and requires exact equality. Existing untracked files in the source are neither copied nor modified.

## 9. Phase gate

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-8
```

The gate pins Godot `4.7.stable.official.5b4e0cb0f`; checks generated protocol drift; runs build, lint, typecheck, protocol/control-plane/MCP/testkit units, disposable fixture import and GDScript units, authenticated scenario and visual integrations, hostile inputs, cancellation and cleanup, published stdio E2E, serialized regression tests, isolated `town-building-game` acceptance when the checkout is present, source-checkout immutability proof, and committed/working diff checks.

The current session denies localhost listeners. Per the user’s explicit override, that environmental failure is recorded as skipped rather than passed; Phase 8 is not called fully green unless the complete gate later exits zero in a loopback-capable session.

## 10. Exclusions

Phase 8 does not add baseline replacement/deletion, arbitrary host image paths, perceptual or AI comparison, DOM-like selectors, expression evaluation, method invocation, custom GDScript, project mutation, import/reimport, build/export, unsafe fixture execution, or compatibility claims beyond the Godot 4.7 macOS baseline.
