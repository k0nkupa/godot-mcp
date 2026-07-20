# Phase 9 Project and Build Operations Implementation Plan

> Execute inline in this session. Follow red-green-refactor for production behavior and preserve every environmental skip honestly.

**Goal:** Add permission-gated, cancellable, recoverable Godot project/import/build/export operations whose release artifacts are contained, scanned, and proven free of MCP components.

**Architecture:** One `godot_project` MCP tool delegates short transactional editor changes to a narrow authenticated addon adapter and long operations to one journaled control-plane job service. A fixed Godot process runner owns children and a streaming artifact store/scanner owns export outputs.

**Tech stack:** Node.js 22, TypeScript 6, Zod 4, MCP SDK, Vitest, Godot 4.7, GDScript.

## Constraints

- Require `project_operate` plus `project`; add exactly one tool.
- No shell, arbitrary executable/arguments/environment, caller host paths, or arbitrary GDScript.
- Never modify or export from `town-building-game` directly.
- Export only into an owned empty artifact directory and fail closed on leakage.
- Cancel/kill only a PID plus fingerprint proven to belong to the job.
- Use disposable fixture copies for every project mutation, import, run, build, export, and crash test.
- `.git`, localhost, and pnpm cache restrictions in this session are recorded, not bypassed or called green.

### Task 1: Protocol, grants, and one-tool surface

**Files:**
- Create `packages/protocol/src/projectOperations.ts` and tests.
- Modify protocol exports/schemas, CLI grant normalization/tests, capability policy/tests, MCP server registration/tool-count tests.

1. Write failing tests for every operation, bounds, safe names/paths, opaque tokens, job/report schemas, unknown fields, setting deny rules, artifact URIs, and exact tool counts.
2. Add `PROJECT_POLICY` requiring `project_operate + project`; normalize only explicit valid grants.
3. Add one `godot_project` tool registration with redacted audit summaries.
4. Run protocol/policy/MCP/CLI focused tests and typechecks.

### Task 2: Artifact store and streaming leakage scanner

**Files:**
- Create `packages/control-plane/src/project/artifactStore.ts`, `artifactScanner.ts`, tests, exports.

1. Write failing tests for owned directories, safe labels, regular files, symlink/special-file denial, entry/byte caps, deterministic manifests, split-chunk marker detection, ZIP/PCK path markers, clean bundles, and no host paths.
2. Implement component-wise non-symlink containment under the fixed artifact root.
3. Stream hashes and marker matching with bounded findings and no whole-artifact buffering.
4. Verify focused tests/typecheck/lint.

### Task 3: Owned project-process runner

**Files:**
- Create `packages/control-plane/src/project/projectProcess.ts` and tests.

1. Write failing tests for exact import/run/build/export argument maps, environment scrubbing, output caps, deadlines, cooperative stop, fingerprint ownership, PID-reuse refusal, and idempotent close.
2. Implement only the fixed Godot operation enum and controlled artifact paths.
3. Reuse existing process fingerprint/ownership primitives where sound; do not add general execution.
4. Verify focused tests and typecheck.

### Task 4: Journaled project job service

**Files:**
- Create `packages/control-plane/src/project/projectJobJournal.ts`, `projectJobService.ts`, tests, exports.

1. Write failing lifecycle, session binding, conflict, cancellation, deadline, crash, recovery, stale token, partial artifact, and close tests.
2. Implement one active job, opaque token, atomic append-only journal, phase/progress/cancellation-safety receipts, and protected output evidence.
3. Recover nonterminal records by exact process identity; never signal ambiguous ownership.
4. Verify tests/typecheck/lint.

### Task 5: Transactional project settings and plugin state

**Files:**
- Create addon `project/project_operations.gd`, protocol bridge fixture/unit tests, TypeScript `ProjectMutationService` and tests.
- Modify plugin command router/initialization.

1. Write failing TypeScript/GDScript tests for allow/deny setting names, expected preimages, idempotency, save/postcondition failure rollback, plugin existence/state conflicts, MCP-addon denial, and audit-safe receipts.
2. Implement the narrow main-thread adapter and control-plane wrapper.
3. Keep values primitive/resource-path bounded; never expose raw config text or host paths.
4. Verify TypeScript and disposable Godot unit tests.

### Task 6: Import/reimport and process-job operations

**Files:**
- Extend project adapter/service; add deterministic fixture import assets and integration tests.

1. Write failing full-import, selective-reimport, main/scene run, build-solutions precondition, cancellation-safe phase, timeout, output, and cleanup tests.
2. Implement full import/run/build via the fixed runner and selective reimport through authenticated `EditorFileSystem` only.
3. Expose cancellation safety honestly around non-interruptible editor calls.
4. Verify units and loopback integration where permitted.

### Task 7: Safe export orchestration and standalone smoke

**Files:**
- Add fixture export preset/smoke scene; extend job service; integration/security tests.

1. Write failing tests for missing preset, missing exclusion, occupied artifact dir, active runtime/job conflict, failed export, leak detection, clean manifest, cancellation, and crash residue.
2. Implement release/debug/pack fixed exports with preflight exclusion checks.
3. Scan every output before returning a release-usable receipt.
4. Launch the clean fixture release without MCP and require a smoke marker.

### Task 8: MCP/CLI wiring and published stdio E2E

**Files:**
- Wire `ProjectJobService`, `ProjectMutationService`, and artifact store through CLI runtime lifecycle.
- Add MCP operation tests and `tests/end-to-end/phase-9.test.ts`.

1. Write failing wiring, close-order, exact tool-list, authorization, audit-redaction, and job-lifecycle tests.
2. Implement dependency construction and cleanup before bridge/session shutdown.
3. Run focused MCP/CLI tests and published stdio E2E where loopback is available.

### Task 9: Documentation and Phase 9 gate

**Files:**
- Create `docs/testing/phase-9.md`, `scripts/qa-phase-9.mjs`, cleanup verifier; modify `package.json`, threat model, bridge protocol.

1. Define a 16-stage gate: version, generated drift, build, lint, typecheck, focused units, disposable import, GDScript units, operation integrations, hostile matrix, stdio E2E, clean release/export scan/standalone smoke, serialized regressions, cleanup, committed diff, working-tree diff.
2. Document grants, operations, cancellation safety, artifact bounds, leak markers, exclusions, and exact skipped stages.
3. Run focused static verification and authoritative gate.

### Task 10: Phase review and progression

1. Inline-review authorization, execution confinement, environment leaks, path/symlink containment, process ownership, cancellation/recovery, export false negatives, audit leaks, test gaps, and source-checkout mutation.
2. Run autoreview in local mode if the bundle can be staged/validated; service or staging failure is not a clean verdict.
3. Fix accepted findings test-first and rerun affected checks.
4. Mark Phase 9 green only with a clean gate/review, or apply the user's standing environmental override with exact skips before Phase 10.
