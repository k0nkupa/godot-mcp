# Town Acceptance Visual Oracle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the real `town-building-game` Phase 8 acceptance fail on an immediate/transient or otherwise visually wrong frame and pass only after comparing a settled deterministic frame with a human-approved committed baseline.

**Architecture:** Keep the production MCP protocol and runtime process unchanged. Strengthen only the disposable acceptance harness: pin the external source commit, give its archive a unique macOS Godot user-data directory, seed that directory through the town project's own save/domain code with a deterministic developed state, wait on the existing bounded `frames_elapsed` runtime condition, seed an immutable approved baseline into the disposable evidence store, and compare one settled capture against it. Retain an explicit baseline-candidate mode that always fails after writing review artifacts so baseline updates cannot silently approve themselves.

**Tech Stack:** TypeScript, Vitest, Node.js `fs/promises`, Godot 4.7, existing `godot_visual` scenario and evidence contracts.

## Global Constraints

- Keep MCP on stdio and the bridge on `127.0.0.1`; do not change grants, packs, descriptors, or the normal tool surface.
- Use `/Users/tony/Projects/town-building-game` only through `git archive HEAD`; never install or mutate the source checkout.
- Pin the accepted town source to commit `20482b130f8083bd381b3fd9dff2e0129b06a52f`; a different HEAD must require baseline regeneration and review.
- Pin Godot to `4.7.stable.official.5b4e0cb0f` and retain the existing launch pins: `1280×720`, `gl_compatibility`, locale `en`, seed `42`, fixed FPS `60`.
- Use the existing comparison thresholds: channel delta `4`, at most `9,216` different pixels, and at most `10,000` ratio millionths (1%).
- Use a bounded `frames_elapsed: 30` wait with `timeoutMs: 30_000`; do not add wall-clock sleep or caller-supplied runtime arguments. Live execution rejected the original 300-frame assumption at both ten- and thirty-second bounds because first-run texture fitting makes rendered frames much slower than the fixed simulation FPS.
- A baseline candidate is not approved by generation. It must be visually inspected by a human before its PNG and manifest enter the repository.
- Seed the disposable custom `user://saves` through the pinned town project's own `SaveRepository`, `WorldState`, `DistrictGenerator`, and `BuildingInstance` classes; do not copy ambient user saves or modify the source checkout.
- Preserve source HEAD, NUL-delimited dirty-status digest, and index digest on success and failure.
- Remove the exact disposable project and exact custom Godot user-data directory during cleanup; preserve failure evidence only under `GODOT_MCP_FAILURE_ARTIFACT_DIR`.

---

## Root-cause evidence

- At `c84376a`, `tests/acceptance/town-building-game-phase-8.test.ts:43-59` creates `town-smoke` from the first immediate capture and compares only a second immediate capture against that newly created baseline. This proves repeatability, not correctness.
- The current test contains no readiness step before pause/capture and does not use an independently approved image.
- The exact acceptance passed after a normal build: `1/1` in `119.32s`, confirming the weak oracle is active on the certified commit.
- The saved immediate and five-second captures differ by `72,423 / 291,600` pixels (`248,364` ratio millionths, maximum channel delta `216`), so the existing 1% policy correctly rejects the transient frame when the settled frame is used as the oracle.
- The immediate capture contains large white rectangles; the settled capture renders the buildings. The two saved frames have distinct SHA-256 digests `2d982e58f857dff829ed86e6201f745f47dbcc23fc9695ca8128a8356cc9173b` and `4e56cf96c3ce900483bf741f3e1da09311ced983056c30ca97ce47873ad5d9b0`.
- The normal town launch reads `user://saves`, and the saved captures already differ in coin count. Godot 4.7 on macOS ignored a live `XDG_DATA_HOME` probe, while `application/config/use_custom_user_dir=true` plus a unique `application/config/custom_user_dir_name` produced a unique directory under `~/Library/Application Support`. Therefore the acceptance must configure the disposable archive rather than expand the runtime environment allowlist.

## File structure

- Modify `tests/acceptance/town-building-game-phase-8.test.ts`: source pin, disposable user-data override, candidate mode, approved-baseline staging, settled scenario, failure evidence, and cleanup.
- Create `tests/acceptance/fixtures/town-developed-save.gd`: deterministic developed-state save generator executed only inside the disposable archive before MCP startup.
- Create `tests/acceptance/baselines/town-building-game-phase-8/approval.json`: review metadata binding the baseline to source HEAD, pins, readiness condition, comparison settings, and baseline name.
- Create `tests/acceptance/baselines/town-building-game-phase-8/baseline/manifest.json`: exact `PngBaselineManifest` generated through `godot_visual.baseline_create`.
- Create `tests/acceptance/baselines/town-building-game-phase-8/baseline/approved.png`: human-approved settled PNG; staging verifies its bytes against `manifest.json.sha256` and writes the digest-named disposable evidence file required by the product contract.
- Modify `docs/testing/phase-8.md`: describe the stronger oracle, update procedure, source pin, readiness wait, custom user-data isolation, and retained failure artifacts.

### Task 1: Replace the self-generated smoke baseline with an approved deterministic oracle

**Files:**
- Modify: `tests/acceptance/town-building-game-phase-8.test.ts:1-69`
- Create: `tests/acceptance/fixtures/town-developed-save.gd`
- Create: `tests/acceptance/baselines/town-building-game-phase-8/approval.json`
- Create: `tests/acceptance/baselines/town-building-game-phase-8/baseline/manifest.json`
- Create: `tests/acceptance/baselines/town-building-game-phase-8/baseline/approved.png`

**Interfaces:**
- Consumes: existing `ScenarioDeclaration`, `ScenarioReport`, `launchEditor`, `launchMcpClient`, `runCli`, `runGodot`, `waitUntil`, `inspectPng`, and `godot_visual` operations.
- Produces: a normal acceptance path that can only pass against the committed oracle, plus `GODOT_MCP_UPDATE_TOWN_BASELINE=1` candidate generation that writes artifacts and deliberately fails for human review.

- [ ] **Step 1: Add the baseline constants and file imports**

Extend the imports without adding a production dependency:

```ts
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { ScenarioDeclaration, ScenarioReport } from "@godot-mcp/protocol";
import { inspectPng, launchEditor, launchMcpClient, reserveLoopbackPort, runCli, runGodot, waitUntil } from "@godot-mcp/testkit";
```

Add these exact constants below `sourcePresent`:

```ts
const expectedSourceHead = "20482b130f8083bd381b3fd9dff2e0129b06a52f";
const baselineName = "town-smoke-approved";
const baselineBundle = join(process.cwd(), "tests/acceptance/baselines/town-building-game-phase-8");
const pins = { width: 1280, height: 720, renderer: "gl_compatibility" as const, locale: "en", seed: 42, fixedFps: 60 as const };
const readiness = { kind: "wait" as const, timeoutMs: 30_000, condition: { type: "frames_elapsed" as const, frames: 30 } };
const comparisonSettings = { masks: [], maxChannelDelta: 4, maxDifferentPixels: 9_216, maxDifferentRatioMillionths: 10_000 };
const updateBaseline = process.env.GODOT_MCP_UPDATE_TOWN_BASELINE === "1";
```

- [ ] **Step 2: Make the missing approved bundle the initial failing test**

Immediately after `const before = await sourceState();`, enforce the source pin in normal certification and load the committed bundle. Explicit candidate mode may inspect a new source HEAD, but it still cannot pass and writes that exact HEAD into the candidate metadata:

```ts
if (!updateBaseline) {
  expect(before.head, "town-building-game HEAD changed; regenerate and review the Phase 8 baseline").toBe(expectedSourceHead);
}
const approved = updateBaseline ? undefined : await readApprovedBaseline();
```

Run:

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm exec vitest run tests/acceptance/town-building-game-phase-8.test.ts --fileParallelism=false
```

Expected: FAIL before launching Godot because `approval.json` does not exist. This is the regression test's red state.

- [ ] **Step 3: Configure an isolated macOS Godot user-data directory in the disposable archive**

Before entering `try`, derive a unique directory from the already-safe temporary container name so the exact path remains available to `finally`; after extracting `project`, apply the override:

```ts
const customUserDataName = basename(container);
if (!customUserDataName.startsWith("godot-mcp-phase8-town-")) {
  throw new Error("Refusing an unexpected custom user-data name");
}
const userDataDirectory = join(homedir(), "Library", "Application Support", customUserDataName);
await configureCustomUserData(project, customUserDataName);
```

Add this helper. It changes only the archive, refuses malformed names, and inserts settings into the existing `[application]` section:

```ts
async function configureCustomUserData(project: string, name: string): Promise<void> {
  if (!/^godot-mcp-phase8-town-[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error("Custom user-data name is outside the acceptance namespace");
  }
  const path = join(project, "project.godot");
  const settings = await readFile(path, "utf8");
  const header = "[application]\n";
  if (!settings.includes(header) || settings.includes("config/use_custom_user_dir")) {
    throw new Error("Disposable project application settings cannot be safely amended");
  }
  const isolated = settings.replace(
    header,
    `${header}\nconfig/use_custom_user_dir=true\nconfig/custom_user_dir_name="${name}"\n`,
  );
  await writeFile(path, isolated, "utf8");
}
```

In `finally`, after closing the editor and before asserting source integrity, remove only this validated directory:

```ts
if (!basename(userDataDirectory).startsWith("godot-mcp-phase8-town-")) {
  throw new Error("Refusing to remove an unexpected Godot user-data directory");
}
await rm(userDataDirectory, { recursive: true, force: true });
```

- [ ] **Step 4: Validate and stage the committed baseline before launching the editor**

Before staging the baseline, copy `tests/acceptance/fixtures/town-developed-save.gd` into `.godot-mcp/acceptance/` in the archive, run it headlessly through Godot, require the `GODOT_MCP_TOWN_SAVE_READY` marker and `user://saves/town.json`, then remove the copied script. The generator must construct seed `4107`, the four developed QA buildings (`home`, `boba_cafe`, `fried_chicken`, `pocket_park`), population `18`, vibe `42`, and fixed Unix time `4_102_444_800` through the town project's own classes. This state setup happens after import and before `godot-mcp init`.

After `runCli(["init", "--project", project])` succeeds, call:

```ts
if (approved) await stageApprovedBaseline(project, approved);
```

Add the validation and staging helpers. They verify the source binding, manifest identity, PNG digest, byte length, and decoded dimensions before copying into the disposable evidence store:

```ts
interface ApprovedTownBaseline {
  approval: {
    schemaVersion: 1;
    sourceHead: string;
    baselineName: string;
    pins: typeof pins;
    readiness: typeof readiness;
    comparisonSettings: typeof comparisonSettings;
  };
  manifest: {
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
  };
  png: Buffer;
}

async function readApprovedBaseline(): Promise<ApprovedTownBaseline> {
  const approval = JSON.parse(await readFile(join(baselineBundle, "approval.json"), "utf8")) as ApprovedTownBaseline["approval"];
  const manifest = JSON.parse(await readFile(join(baselineBundle, "baseline", "manifest.json"), "utf8")) as ApprovedTownBaseline["manifest"];
  expect(approval).toEqual({
    schemaVersion: 1,
    sourceHead: expectedSourceHead,
    baselineName,
    pins,
    readiness,
    comparisonSettings,
  });
  expect(manifest).toMatchObject({
    schemaVersion: 1,
    comparisonContractVersion: 1,
    name: baselineName,
    mimeType: "image/png",
    sourceObservationSha256: manifest.sha256,
  });
  const png = await readFile(join(baselineBundle, "baseline", "approved.png"));
  expect(createHash("sha256").update(png).digest("hex")).toBe(manifest.sha256);
  expect(png.byteLength).toBe(manifest.byteLength);
  expect(inspectPng(png)).toMatchObject({ width: manifest.width, height: manifest.height });
  return { approval, manifest, png };
}

async function stageApprovedBaseline(project: string, approved: ApprovedTownBaseline): Promise<void> {
  const destination = join(project, ".godot/evidence/godot-mcp/baselines", approved.manifest.name);
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, "manifest.json"), `${JSON.stringify(approved.manifest)}\n`, "utf8");
  await writeFile(join(destination, `${approved.manifest.sha256}.png`), approved.png);
}
```

- [ ] **Step 5: Replace the two self-referential scenarios with one settled scenario**

Delete both `town-smoke-source` and `town-smoke-repeat`. Run one scenario whose normal path waits, checks logs, pauses, captures, and compares:

```ts
const steps: ScenarioDeclaration["steps"] = [
  readiness,
  { kind: "assert", assertion: { type: "no_error_logs" } },
  { kind: "control", action: "pause" },
  { kind: "capture", label: "town", maxWidth: 1280, maxHeight: 720, frameCount: 1, intervalFrames: 1, advancePaused: true },
  ...(!updateBaseline ? [{
    kind: "compare" as const,
    captureLabel: "town",
    frameIndex: 0,
    baselineName,
    settings: comparisonSettings,
  }] : []),
];
const report = await runScenario(client, townScenario("town-smoke-approved", steps));
```

Normal mode must assert:

```ts
expect(report).toMatchObject({
  state: "completed",
  failedStepIndex: null,
  cleanup: "succeeded",
  steps: expect.arrayContaining([
    expect.objectContaining({ kind: "wait", state: "completed" }),
    expect.objectContaining({ kind: "capture", state: "completed" }),
    expect.objectContaining({ kind: "compare", state: "completed", summary: expect.objectContaining({ passed: true }) }),
  ]),
});
```

If the report is not completed and `GODOT_MCP_FAILURE_ARTIFACT_DIR` is set, copy `.godot/evidence/godot-mcp` before asserting so the current, diff, and report remain inspectable after disposable cleanup:

```ts
if (report.state !== "completed" && process.env.GODOT_MCP_FAILURE_ARTIFACT_DIR) {
  await cp(
    join(project, ".godot/evidence/godot-mcp"),
    join(process.env.GODOT_MCP_FAILURE_ARTIFACT_DIR, "town-building-game-phase-8-evidence"),
    { recursive: true, force: true },
  );
}
```

- [ ] **Step 6: Add explicit baseline-candidate generation that cannot pass the gate**

When `GODOT_MCP_UPDATE_TOWN_BASELINE=1`, the scenario omits comparison. Create the baseline only after the readiness and capture steps complete, then copy the immutable baseline directory and write approval metadata into the failure-artifact directory:

```ts
if (updateBaseline) {
  expect(report).toMatchObject({ state: "completed", cleanup: "succeeded" });
  const observationUri = report.steps.find((step) => step.kind === "capture")?.evidence[0];
  expect(observationUri).toBeTypeOf("string");
  await callVisual(client, { operation: "baseline_create", name: baselineName, observationUri });
  const artifactRoot = process.env.GODOT_MCP_FAILURE_ARTIFACT_DIR;
  if (!artifactRoot) throw new Error("GODOT_MCP_FAILURE_ARTIFACT_DIR is required in baseline-update mode");
  const candidate = join(artifactRoot, "town-building-game-phase-8-candidate");
  await mkdir(candidate, { recursive: true });
  await cp(
    join(project, ".godot/evidence/godot-mcp/baselines", baselineName),
    join(candidate, "baseline"),
    { recursive: true },
  );
  await writeFile(join(candidate, "approval.json"), `${JSON.stringify({
    schemaVersion: 1,
    sourceHead: before.head,
    baselineName,
    pins,
    readiness,
    comparisonSettings,
  }, null, 2)}\n`, "utf8");
  throw new Error(`Baseline candidate written to ${candidate}; visual approval is required before commit`);
}
```

This branch must always throw after writing the candidate. The normal Phase 8 gate never sets the update flag.

- [ ] **Step 7: Generate and visually approve the deterministic candidate**

Run:

```bash
mkdir -p /private/tmp/godot-mcp-town-baseline-candidate
GODOT_MCP_UPDATE_TOWN_BASELINE=1 \
GODOT_MCP_FAILURE_ARTIFACT_DIR=/private/tmp/godot-mcp-town-baseline-candidate \
GODOT_BIN=/opt/homebrew/bin/godot \
pnpm exec vitest run tests/acceptance/town-building-game-phase-8.test.ts --fileParallelism=false
```

Expected: FAIL only with a message beginning `Baseline candidate written to /private/tmp/godot-mcp-town-baseline-candidate/` and ending `visual approval is required before commit`, after a completed scenario and successful cleanup.

Open the single PNG under `/private/tmp/godot-mcp-town-baseline-candidate/town-building-game-phase-8-candidate/baseline/`. Approval criteria:

- no large white rectangles or blank building/resident placeholders;
- buildings, residents, terrain, and HUD are present;
- no error/recovery overlay is visible;
- the image represents the isolated deterministic developed state created through source HEAD `20482b130f8083bd381b3fd9dff2e0129b06a52f`;
- decoded dimensions and manifest values match.

Stop and request user approval at this point. After approval, copy the candidate `approval.json` and `baseline/manifest.json` without rewriting either JSON file, and copy the candidate's digest-named PNG bytes to the exact repository path `tests/acceptance/baselines/town-building-game-phase-8/baseline/approved.png`.

- [ ] **Step 8: Run the regression and verify the approved oracle passes**

Run:

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm exec vitest run tests/acceptance/town-building-game-phase-8.test.ts --fileParallelism=false
```

Expected: PASS `1/1`; the report includes completed wait, capture, and comparison steps; cleanup succeeds; the original town source HEAD/status/index fingerprints remain identical; the custom user-data directory and disposable archive no longer exist.

- [ ] **Step 9: Commit the acceptance slice**

```bash
git add tests/acceptance/town-building-game-phase-8.test.ts tests/acceptance/baselines/town-building-game-phase-8
git commit -m "test: require approved town visual baseline"
```

### Task 2: Document and recertify the strengthened release gate

**Files:**
- Modify: `docs/testing/phase-8.md:21-31`

**Interfaces:**
- Consumes: the acceptance contract from Task 1.
- Produces: the operator procedure for normal certification and deliberate baseline refresh.

- [ ] **Step 1: Update the realistic-acceptance contract**

Replace the existing paragraph under `## Realistic acceptance` with text covering all of these exact facts:

```markdown
When `/Users/tony/Projects/town-building-game` exists, acceptance requires source HEAD `20482b130f8083bd381b3fd9dff2e0129b06a52f`, records its NUL-delimited working-tree status and index digests, and materializes `git archive HEAD` into a disposable directory. The archive receives a unique macOS Godot custom user-data directory so ambient `user://saves` cannot affect the run, then creates a deterministic four-building developed state through the pinned town project's own save/domain classes. The scenario waits 30 rendered engine frames (bounded by thirty seconds), rejects runtime error logs, pauses, captures `res://scenes/main.tscn`, and compares it with the committed human-approved `town-smoke-approved` baseline using channel delta 4 and the simultaneous 9,216-pixel/1% limits. It never creates its pass oracle during a normal gate run. Success and failure both remove the disposable archive and custom user-data directory and must leave the source checkout's HEAD, recorded status digest, and index digest unchanged.

Baseline refresh is deliberately separate: set `GODOT_MCP_UPDATE_TOWN_BASELINE=1` and `GODOT_MCP_FAILURE_ARTIFACT_DIR` while running the focused acceptance. Candidate mode writes the settled immutable baseline bundle and then fails intentionally. A human must inspect the PNG and approve it before the complete bundle is copied into `tests/acceptance/baselines/town-building-game-phase-8/`. A changed town source HEAD requires the same regeneration and approval flow.
```

- [ ] **Step 2: Run targeted static validation**

Run:

```bash
pnpm lint
pnpm typecheck
git diff --check
```

Expected: all commands exit `0`.

- [ ] **Step 3: Run the authoritative Phase 8 gate**

Run:

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-8
```

Expected: `PASS (16/16 stages)`. Do not claim skipped stages passed.

- [ ] **Step 4: Re-run the release-level regression gate and review**

Run:

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-11
```

Expected: Phase 11 passes with the updated test count and clean-diff checks. Then run the repository's `autoreview` workflow on the final diff; address every actionable finding and rerun only checks invalidated by any resulting edit.

- [ ] **Step 5: Commit the documentation and certification receipt**

```bash
git add docs/testing/phase-8.md
git commit -m "docs: strengthen town visual acceptance"
```

Record the exact focused acceptance duration, Phase 8 stage count, Phase 11 test count, and review result in the execution receipt. Do not describe GitHub compatibility, npm publication, GitHub release, or Asset Library submission as tested by these local gates.

## Self-review

- Spec coverage: the plan preserves the source-checkout isolation, fixed runtime pins, closed scenario operations, bounded waits, immutable evidence format, comparison thresholds, cleanup proof, and release validation contract.
- Root-cause coverage: it removes the self-generated pass oracle, adds render settling, replaces ambient saves with a deterministic developed state, pins the external source revision, preserves failed visual evidence, and requires human approval for baseline changes.
- Security review: no raw runtime arguments, host-path MCP inputs, shell capability, environment expansion, or production protocol surface is added. The only host path added is a test-owned custom Godot user-data directory derived from the already validated disposable namespace and removed explicitly.
- Placeholder scan: the repository uses the exact filename `approved.png`; its digest is generated by the immutable evidence store, retained in the unedited manifest, and verified again before staging. No guessed digest or manually edited manifest is permitted.
- Validation scope: focused acceptance first, then lint/typecheck, the complete Phase 8 gate, the Phase 11 release regression gate, and final review.
