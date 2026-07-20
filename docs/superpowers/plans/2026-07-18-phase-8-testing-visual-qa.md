# Phase 8 Testing and Visual QA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add authenticated, bounded declarative playtest jobs and deterministic screenshot-baseline comparison with useful evidence and isolated realistic acceptance.

**Architecture:** A visual-only MCP tool delegates baseline and comparison work to a content-addressed evidence layer and scenario orchestration to an in-memory control-plane job service. Scenarios compose the existing authenticated runtime, input, and capture interfaces; Godot receives only pinned launch metadata and the earlier closed runtime commands.

**Tech Stack:** Node.js 22; pnpm 11.13.0; TypeScript 6.0.3; Zod 4.4.3; MCP TypeScript SDK 1.29.0; Vitest 4.1.10; pngjs 7.0.0; Godot 4.7 stable; GDScript.

## Global Constraints

- Keep MCP on stdio and every Godot bridge listener on `127.0.0.1`.
- Default sessions expose exactly six observe-only tools; runtime adds exactly two tools; input adds exactly one tool.
- Register `godot_visual` only with `runtime_control` and all of `runtime`, `input`, and `visual`.
- Never accept caller-selected host paths, arbitrary evaluation, method calls, scripts, sockets, or general protocol passthrough.
- Limit scenario documents to 512 KiB, 64 steps, 120 seconds, 256 events per input step, and eight frames per capture.
- Limit PNG evidence to eight MiB and canonical JSON evidence to one MiB.
- Use disposable fixture copies; never mutate `/Users/tony/Projects/town-building-game`.
- Follow red-green-refactor for every production behavior.
- The current sandbox cannot bind loopback or write `.git`; record affected checks and commits as skipped, never passed.

---

## File map

```text
packages/protocol/src/visual.ts                         Public schemas and report types
packages/protocol/src/runtime.ts                        Re-export shared wait and path schemas
packages/protocol/src/runtimeShared.ts                  Pinned launch schema
packages/protocol/src/schemas.ts                        visual capability exposure
packages/control-plane/src/evidence/evidenceStore.ts    Verified reads, JSON evidence, baselines
packages/control-plane/src/visual/pngComparison.ts      Deterministic RGBA comparison
packages/control-plane/src/visual/scenarioService.ts    Job lifecycle and step orchestration
packages/control-plane/src/runtime/runtimeDescriptor.ts Authenticated launch pins
packages/control-plane/src/runtime/runtimeProcess.ts    Fixed bounded Godot engine arguments
packages/control-plane/src/policy/capabilities.ts       Visual command policy
packages/mcp-server/src/registerVisualTools.ts          One visual MCP tool and audit summaries
packages/mcp-server/src/createServer.ts                 Exact grant-gated registration
packages/testkit/src/visual.ts                          PNG fixture and assertion helpers
fixtures/godot-4.7/visual/*                             Deterministic visual fixture
tests/integration/visual-scenario.test.ts               Authenticated real-runtime acceptance
tests/security/visual-hostile.test.ts                   Hostile declaration/evidence matrix
tests/end-to-end/phase-8.test.ts                        Published stdio acceptance
tests/acceptance/town-building-game-phase-8.test.ts     Read-only source proof and archive copy
scripts/qa-phase-8.mjs                                  Serialized phase gate
docs/testing/phase-8.md                                 Certified surface and gate receipt
```

### Task 1: Protocol and capability contracts

**Files:**
- Create: `packages/protocol/src/visual.ts`
- Create: `packages/protocol/src/visual.test.ts`
- Modify: `packages/protocol/src/runtime.ts`
- Modify: `packages/protocol/src/runtimeShared.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/src/schemas.ts`
- Modify: `packages/protocol/src/schemas.test.ts`

**Interfaces:**
- Produces: `VisualOperationInputSchema`, `ScenarioDeclarationSchema`, `ScenarioJobReceiptSchema`, `ScenarioReportSchema`, `VisualComparisonResultSchema`, `RuntimeLaunchPinsSchema` and inferred TypeScript types.
- Consumes: existing runtime handle, wait condition, input trace, and capture-bound contracts.

- [ ] **Step 1: Write failing schema tests**

Add tests that parse one complete 7-step declaration (`wait`, `assert`, `control`, `input`, `capture`, `compare`, `assert`), then reject unknown keys, 65 steps, duplicate capture labels, compare-before-capture, traversal scene paths, out-of-range regions/masks/tolerances, a document over 512 KiB, and malformed evidence URIs. Assert `CapabilityPackSchema` accepts `visual` while existing pack parsing remains unchanged.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
pnpm exec vitest run packages/protocol/src/visual.test.ts packages/protocol/src/schemas.test.ts
```

Expected: FAIL because `visual.ts` and `visual` capability support do not exist.

- [ ] **Step 3: Implement the strict schemas**

Use these exact top-level shapes:

```ts
export const VisualOperationInputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("baseline_create"), name: VisualNameSchema, observationUri: EvidenceObservationUriSchema }).strict(),
  z.object({ operation: z.literal("baseline_get"), name: VisualNameSchema }).strict(),
  z.object({ operation: z.literal("compare"), name: VisualNameSchema, observationUri: EvidenceObservationUriSchema, settings: VisualComparisonSettingsSchema }).strict(),
  z.object({ operation: z.literal("scenario_start"), scenario: ScenarioDeclarationSchema }).strict(),
  z.object({ operation: z.literal("scenario_status"), jobToken: ScenarioJobTokenSchema }).strict(),
  z.object({ operation: z.literal("scenario_cancel"), jobToken: ScenarioJobTokenSchema }).strict(),
  z.object({ operation: z.literal("scenario_result"), jobToken: ScenarioJobTokenSchema }).strict(),
]);
```

Export the existing runtime scene path and wait-condition schemas instead of copying their validation. Add `RuntimeLaunchPinsSchema` with width/height 1–2048, renderer enum, locale regex `^[A-Za-z]{2,3}(?:_[A-Za-z]{2})?$`, signed 32-bit seed, and fixed FPS `30 | 60 | 120`. Use `superRefine` for unique labels and backward-only capture references, and measure the canonical JSON UTF-8 length.

- [ ] **Step 4: Verify GREEN and typecheck**

Run:

```bash
pnpm exec vitest run packages/protocol/src/visual.test.ts packages/protocol/src/schemas.test.ts
pnpm --filter @godot-mcp/protocol typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src
git commit -m "feat: define visual scenario contracts"
```

If `.git` remains read-only, record this commit as skipped and continue without claiming it exists.

### Task 2: Verified evidence reads, JSON reports, and immutable baselines

**Files:**
- Modify: `packages/control-plane/src/evidence/evidenceStore.ts`
- Modify: `packages/control-plane/src/evidence/evidenceStore.test.ts`
- Modify: `packages/control-plane/src/index.ts`

**Interfaces:**
- Produces: `readSessionPngObservation(sessionId, uri)`, `putJson(sessionId, value, metadata)`, `createPngBaseline(sessionId, name, observationUri)`, and `readPngBaseline(name)`.
- Consumes: Phase 2 content-addressed PNG layout and `GodotMcpException`.

- [ ] **Step 1: Write failing containment and persistence tests**

Cover valid current-session read, cross-session observation rejection, wrong digest, symlinked evidence/baseline file rejection, malformed URI, one-MiB JSON boundary, atomic JSON write, same-content idempotent baseline creation, different-content name conflict, owner-only permissions, and absence of host paths in returned metadata.

- [ ] **Step 2: Verify RED**

```bash
pnpm exec vitest run packages/control-plane/src/evidence/evidenceStore.test.ts
```

Expected: FAIL on the missing methods.

- [ ] **Step 3: Implement canonical verified storage**

Resolve all paths from validated identifiers, call `realpath` on the store root and existing parents, reject symbolic links with `lstat`, re-hash bytes on every read, parse observation JSON through a strict internal schema, and ensure its `sha256` and session directory match the URI. Canonical JSON evidence uses `canonicalJson` from the protocol package and a media type of `application/json`.

Baseline manifests use:

```ts
interface PngBaselineManifest {
  schemaVersion: 1;
  comparisonContractVersion: 1;
  name: string;
  sha256: string;
  mimeType: "image/png";
  byteLength: number;
  width: number;
  height: number;
  sourceObservationSha256: string;
  createdAtUnixMs: number;
}
```

- [ ] **Step 4: Verify GREEN**

```bash
pnpm exec vitest run packages/control-plane/src/evidence/evidenceStore.test.ts
pnpm --filter @godot-mcp/control-plane typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/control-plane/src/evidence packages/control-plane/src/index.ts
git commit -m "feat: store verified visual evidence"
```

### Task 3: Deterministic PNG comparison

**Files:**
- Create: `packages/control-plane/src/visual/pngComparison.ts`
- Create: `packages/control-plane/src/visual/pngComparison.test.ts`
- Modify: `packages/control-plane/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/control-plane/src/index.ts`
- Create: `packages/testkit/src/visual.ts`
- Create: `packages/testkit/src/visual.test.ts`
- Modify: `packages/testkit/src/index.ts`

**Interfaces:**
- Produces: `comparePng(input): Promise<{ result: VisualComparisonResult; diffPng?: Uint8Array }>`.
- Consumes: strict protocol comparison settings and bounded PNG bytes.

- [ ] **Step 1: Write failing pixel-contract tests**

Generate 4×4 RGBA PNGs and assert exact equality, one-channel boundary behavior, both count and ratio limits, transparent-pixel comparison, region clipping rejection, masked differences, dimension mismatch, malformed PNG rejection, and deterministic red-highlight diff bytes/digest.

- [ ] **Step 2: Verify RED**

```bash
pnpm exec vitest run packages/control-plane/src/visual/pngComparison.test.ts packages/testkit/src/visual.test.ts
```

Expected: FAIL because comparison modules do not exist.

- [ ] **Step 3: Add the existing locked `pngjs` version as a runtime dependency**

```bash
pnpm --filter @godot-mcp/control-plane add pngjs@7.0.0 --offline
pnpm --filter @godot-mcp/control-plane add -D @types/pngjs@6.0.5 --offline
```

Expected: package manifest and lockfile change without network access.

- [ ] **Step 4: Implement the bounded comparator**

Decode synchronously inside a rejected-size guard, validate decoded dimensions and `width * height <= 4_194_304`, iterate only the selected region, test masks before channel deltas, and calculate ratio millionths as `floor(different * 1_000_000 / compared)` with zero when no pixels are compared. Diff pixels preserve the current image when equal and become opaque red when different. Hash the canonical result without `resultSha256`, then append the digest.

- [ ] **Step 5: Verify GREEN**

```bash
pnpm exec vitest run packages/control-plane/src/visual/pngComparison.test.ts packages/testkit/src/visual.test.ts
pnpm --filter @godot-mcp/control-plane typecheck
pnpm --filter @godot-mcp/testkit typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/control-plane packages/testkit pnpm-lock.yaml
git commit -m "feat: compare bounded visual evidence"
```

### Task 4: Scenario job service

**Files:**
- Create: `packages/control-plane/src/visual/scenarioService.ts`
- Create: `packages/control-plane/src/visual/scenarioService.test.ts`
- Modify: `packages/control-plane/src/index.ts`

**Interfaces:**
- Produces: `ScenarioService.start`, `.status`, `.cancel`, `.result`, and `.close`.
- Consumes: narrow `ScenarioRuntime`, `ScenarioInput`, `ScenarioVisual`, `EvidenceStore`, and session/project identity dependencies.

- [ ] **Step 1: Write failing lifecycle tests**

Use real in-memory fakes with recorded calls. Cover serial step order, exact failed-step index, assertion success/failure, wait timeout, control forwarding, deterministic input requiring pause, capture label binding, comparison evidence, duplicate active-job conflict, opaque stale token, session mismatch, cooperative cancellation, global deadline, runtime disconnect, cleanup after every terminal state, cleanup failure reporting, result-before-terminal conflict, and close idempotency.

- [ ] **Step 2: Verify RED**

```bash
pnpm exec vitest run packages/control-plane/src/visual/scenarioService.test.ts
```

Expected: FAIL because `ScenarioService` is missing.

- [ ] **Step 3: Implement the job state machine**

Use an internal record with an unexposed UUID and expose only an HMAC-like random token generated from 32 random bytes. Copy and parse every public result through protocol schemas. Start execution with `queueMicrotask`, carry one `AbortController`, race each awaited operation against the remaining deadline, and check cancellation before and after each boundary. Always call `runtime.execute({ operation: "stop", handle })` in `finally` when launch produced a handle.

Assertions must use existing runtime `node`, `logs`, and zero/short-time `wait` operations; do not evaluate expressions. Save canonical terminal reports through `EvidenceStore.putJson` and include its observation URI.

- [ ] **Step 4: Verify GREEN**

```bash
pnpm exec vitest run packages/control-plane/src/visual/scenarioService.test.ts
pnpm --filter @godot-mcp/control-plane typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/control-plane/src/visual packages/control-plane/src/index.ts
git commit -m "feat: run declarative visual scenarios"
```

### Task 5: Authenticated deterministic launch pins

**Files:**
- Modify: `packages/protocol/src/runtime.ts`
- Modify: `packages/control-plane/src/runtime/runtimeDescriptor.ts`
- Modify: `packages/control-plane/src/runtime/runtimeDescriptor.test.ts`
- Modify: `packages/control-plane/src/runtime/runtimeProcess.ts`
- Modify: `packages/control-plane/src/runtime/runtimeProcess.test.ts`
- Modify: `packages/control-plane/src/runtime/runtimeService.ts`
- Modify: `packages/control-plane/src/runtime/runtimeService.test.ts`
- Modify: `addons/godot_mcp/runtime/runtime_harness.gd`
- Modify: `fixtures/godot-4.7/tests/runtime_harness_unit.gd`

**Interfaces:**
- Produces: `RuntimeService.launch({ scenePath, startupTimeoutMs, pins? })` with pins signed into the one-use descriptor.
- Consumes: `RuntimeLaunchPinsSchema`.

- [ ] **Step 1: Write failing TypeScript and GDScript tests**

Assert pins survive descriptor creation/readback, produce only these engine arguments—`--resolution`, `--rendering-method`, `--language`, `--fixed-fps`—and never accept raw arguments. Assert the harness receives the exact integer seed through authenticated run metadata and reports observed pins in its ready message.

- [ ] **Step 2: Verify RED**

```bash
pnpm exec vitest run packages/control-plane/src/runtime/runtimeDescriptor.test.ts packages/control-plane/src/runtime/runtimeProcess.test.ts packages/control-plane/src/runtime/runtimeService.test.ts
GODOT_BIN=/opt/homebrew/bin/godot /opt/homebrew/bin/godot --headless --path fixtures/godot-4.7 --script res://tests/runtime_harness_unit.gd
```

Expected: FAIL because launch pins are not represented.

- [ ] **Step 3: Implement the fixed pin mapping**

Include pins inside the signed descriptor envelope. Build engine arguments from parsed fields, never strings supplied by callers. Set the seed before loading the game scene. Extend runtime-ready metadata with the observed runtime-window resolution, renderer, locale, seed, and fixed FPS.

- [ ] **Step 4: Verify GREEN and earlier launch security**

```bash
pnpm exec vitest run packages/control-plane/src/runtime/runtimeDescriptor.test.ts packages/control-plane/src/runtime/runtimeProcess.test.ts packages/control-plane/src/runtime/runtimeService.test.ts tests/security/runtime-hostile.test.ts
GODOT_BIN=/opt/homebrew/bin/godot /opt/homebrew/bin/godot --headless --path fixtures/godot-4.7 --script res://tests/runtime_harness_unit.gd
```

Expected: unit/GDScript checks PASS; the loopback-dependent hostile test is run only where localhost is permitted.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol packages/control-plane addons/godot_mcp/runtime fixtures/godot-4.7/tests
git commit -m "feat: pin scenario runtime launches"
```

### Task 6: Visual MCP tool and exact capability gating

**Files:**
- Create: `packages/mcp-server/src/registerVisualTools.ts`
- Create: `packages/mcp-server/src/registerVisualTools.test.ts`
- Modify: `packages/mcp-server/src/createServer.ts`
- Modify: `packages/mcp-server/src/createServer.test.ts`
- Modify: `packages/control-plane/src/policy/capabilities.ts`
- Modify: `packages/control-plane/src/policy/authorize.test.ts`
- Modify: `packages/mcp-server/src/index.ts`

**Interfaces:**
- Produces: one `godot_visual` MCP tool.
- Consumes: `ScenarioService`, `EvidenceStore`, `comparePng`, session attachment, audit, and protocol schemas.

- [ ] **Step 1: Write failing tool-list, authorization, result, and redaction tests**

Assert tool counts for default, runtime, input, editor, partial visual grants, and complete visual grants. Assert each operation forwards parsed values, returns image content only for a produced diff, emits resource observation URIs, and audits counts/digests without property values, input unicode, log text, PNG bytes, or paths.

- [ ] **Step 2: Verify RED**

```bash
pnpm exec vitest run packages/mcp-server/src/registerVisualTools.test.ts packages/mcp-server/src/createServer.test.ts packages/control-plane/src/policy/authorize.test.ts
```

Expected: FAIL because the visual policy and tool are absent.

- [ ] **Step 3: Implement grant-gated registration**

Add `VISUAL_POLICY` with `runtime_control`, `visual`, and `mutating: true`. Register the tool only when the dependency exists and grants include `runtime`, `input`, and `visual`; `executeTool` still enforces the visual policy. Build audit arguments from operation/name/counts only. Convert comparison failures into successful tool execution with `passed: false`; reserve MCP errors for invalid requests or operational failures.

- [ ] **Step 4: Verify GREEN**

```bash
pnpm exec vitest run packages/mcp-server/src/registerVisualTools.test.ts packages/mcp-server/src/createServer.test.ts packages/control-plane/src/policy/authorize.test.ts
pnpm --filter @godot-mcp/mcp-server typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server packages/control-plane/src/policy
git commit -m "feat: expose gated visual QA tool"
```

### Task 7: Deterministic fixture, integration, hostile, and stdio acceptance

**Files:**
- Create: `fixtures/godot-4.7/visual/visual_fixture.gd`
- Create: `fixtures/godot-4.7/visual/visual_fixture.tscn`
- Create: `fixtures/godot-4.7/tests/visual_fixture_unit.gd`
- Create: `tests/integration/visual-scenario.test.ts`
- Create: `tests/integration/visual-phase8-fixture.ts`
- Create: `tests/security/visual-hostile.test.ts`
- Create: `tests/end-to-end/phase-8.test.ts`

**Interfaces:**
- Produces: a fixture with stable quadrants, one animated masked rectangle, an input-driven state label, and a deliberate visual-delta switch.
- Consumes: published MCP server, authenticated editor/runtime fixture, and visual contracts.

- [ ] **Step 1: Add the fixture and failing GDScript behavior test**

The scene renders at 320×180 with four integer-aligned `ColorRect` quadrants. `visual_fixture.gd` exposes primitive `mode`, `input_count`, and `intentional_delta`; action `ui_accept` increments `input_count`; `intentional_delta` changes exactly a 10×10 block; a 12×12 animated block is the certified mask target.

- [ ] **Step 2: Verify fixture RED, then implement to GREEN**

```bash
GODOT_BIN=/opt/homebrew/bin/godot /opt/homebrew/bin/godot --headless --path fixtures/godot-4.7 --script res://tests/visual_fixture_unit.gd
```

Expected first: FAIL on missing scene/script. Expected after implementation: output contains `PHASE8_VISUAL_FIXTURE_OK` with no script errors.

- [ ] **Step 3: Write failing integration/security/E2E tests**

Integration runs the same pinned scenario twice, creates one explicit baseline between runs, compares exact and masked frames, then flips `intentional_delta` through fixture input/state and asserts a failed comparison with diff evidence. Hostile tests cover cross-session URIs, traversal names, symlink baselines, oversized declarations, stale job tokens, cancellation races, deadline cleanup, malformed PNGs, and missing grants. E2E calls the built stdio server and verifies the complete job lifecycle and unchanged tool counts.

- [ ] **Step 4: Verify RED then implement fixture wiring to GREEN**

```bash
pnpm exec vitest run tests/integration/visual-scenario.test.ts tests/security/visual-hostile.test.ts tests/end-to-end/phase-8.test.ts --fileParallelism=false
```

Expected first: FAIL on missing fixture wiring. Expected after implementation in a loopback-capable session: PASS. In the current sandbox, `listen EPERM` is recorded as an environmental skip.

- [ ] **Step 5: Commit**

```bash
git add fixtures/godot-4.7/visual fixtures/godot-4.7/tests tests/integration tests/security tests/end-to-end
git commit -m "test: certify visual scenario workflows"
```

### Task 8: Realistic acceptance, documentation, and Phase 8 gate

**Files:**
- Create: `tests/acceptance/town-building-game-phase-8.test.ts`
- Create: `scripts/qa-phase-8.mjs`
- Create: `scripts/verify-phase-8-cleanup.mjs`
- Create: `docs/testing/phase-8.md`
- Modify: `package.json`

**Interfaces:**
- Produces: `pnpm qa:phase-8` and a source-checkout immutability receipt.
- Consumes: all Phase 8 units/integrations and `/Users/tony/Projects/town-building-game` only as a read-only optional source.

- [ ] **Step 1: Write the acceptance test and cleanup verifier first**

Capture source `HEAD`, `git status --porcelain=v1 -z` digest, and `git ls-files -s` digest. Materialize `git archive HEAD` into a temporary directory, initialize the addon there, run two pinned smoke captures of `res://scenes/main.tscn`, and compare them under the documented tolerance. In `finally`, remove only the validated temporary directory. Recompute all three source values and require exact equality even when acceptance fails.

- [ ] **Step 2: Run the acceptance and verify RED**

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm exec vitest run tests/acceptance/town-building-game-phase-8.test.ts --fileParallelism=false
```

Expected: FAIL until the Phase 8 runtime/visual wiring exists; current sandbox may stop earlier with `listen EPERM`.

- [ ] **Step 3: Implement the 16-stage gate**

Stages are: Godot version; generated protocol drift; build; lint; typecheck; focused protocol/control-plane/MCP/testkit units; disposable import; GDScript visual units with mandatory marker and script-error scan; authenticated integration; hostile matrix; published stdio E2E; isolated town acceptance when present; serialized full Vitest suite; cleanup verifier; committed diff check; working-tree diff check. Set `GODOT_MCP_DIFF_BASE` default to `main` and add `qa:phase-8` to `package.json`.

- [ ] **Step 4: Write the certified testing document**

Document exact grants, operations, bounds, comparison mathematics, baseline immutability, scenario lifecycle, audit redaction, town archive behavior, gate command, and known current-session skips. Do not state that an unrun stage passed.

- [ ] **Step 5: Run focused static verification**

```bash
pnpm build
pnpm lint
pnpm typecheck
pnpm exec vitest run packages/protocol/src/visual.test.ts packages/control-plane/src/evidence/evidenceStore.test.ts packages/control-plane/src/visual packages/mcp-server/src/registerVisualTools.test.ts packages/testkit/src/visual.test.ts
git diff --check
```

Expected: PASS.

- [ ] **Step 6: Run the authoritative gate**

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-8
```

Expected in a loopback-capable, Git-writable session: all 16 stages PASS, source acceptance state unchanged, cleanup clean, committed diff clean, and working tree clean. In this session, localhost and Git-write-dependent stages must be reported as skipped/failed, never green.

- [ ] **Step 7: Commit**

```bash
git add package.json scripts/qa-phase-8.mjs scripts/verify-phase-8-cleanup.mjs docs/testing/phase-8.md tests/acceptance/town-building-game-phase-8.test.ts
git commit -m "test: add Phase 8 acceptance gate"
```

### Task 9: Phase review and progression decision

**Files:**
- Review: `git diff main...HEAD`
- Review: all Phase 8 receipts

**Interfaces:**
- Produces: a clean Phase 8 review verdict or actionable findings.

- [ ] **Step 1: Run inline evidence-first review**

Review the whole branch for authorization bypass, path/symlink weaknesses, cross-session evidence access, unbounded inputs/results, cancellation ownership, cleanup gaps, audit leakage, false determinism claims, test gaps, and source-checkout mutations.

- [ ] **Step 2: Run autoreview when its service is available**

```bash
/Users/tony/.agents/skills/autoreview/scripts/autoreview --mode branch --base main
```

Expected: zero accepted/actionable findings. Service/network failure is not a clean verdict.

- [ ] **Step 3: Resolve findings test-first and rerun affected gates**

For each valid finding: write a failing regression, verify RED, implement the narrow fix, verify GREEN, rerun `qa:phase-8`, and repeat review.

- [ ] **Step 4: Advance only with an honest receipt**

Mark Phase 8 green only when the authoritative gate and review are clean. If the user explicitly overrides an environmental gate again, record the exact skipped evidence and proceed without describing Phase 8 as green.
