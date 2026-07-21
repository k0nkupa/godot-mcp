# Phase 4 Determinism Flake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the intermittent Phase 4 release risk by making replay certification compare only state controlled by the recorded trace, while preserving full input-family coverage and adding redaction-safe evidence that exposes any future component drift.

**Architecture:** Keep the production input protocol, `RuntimeInput`, and `RuntimeFrameClock` unchanged. The closed event factory attaches private diagnostic provenance metadata to its internally constructed `InputEvent` objects without changing the wire contract. Split the disposable Godot fixture's current all-input digest from a factory-tagged action/key replay digest. The broad digest continues to certify every supported input family and ambient input; replay tests use the tagged digest plus exact receipt timing. A shared TypeScript helper projects fixture properties and writes failure evidence containing only digest values and changed property names. The marker is not authentication or a protocol security boundary.

**Tech Stack:** Godot 4.7 GDScript, TypeScript, Vitest, Node.js 22, pnpm 11.13.0, Godot MCP disposable fixtures and Phase 4/11 QA gates.

## Global Constraints

- [ ] Start from local `main` at `3fd0bea` and record `git status --short --branch`, `git rev-parse HEAD`, and `git diff --cached --binary | shasum -a 256` before editing. Preserve unrelated work and do not reset the user's changes.
- [ ] Before the first implementation commit, attach the execution worktree to a dedicated branch with `git switch -c fix/phase-4-determinism-flake 3fd0bea`. If that branch already exists, stop and inspect its ref/worktree ownership instead of forcing or deleting it.
- [ ] Use exactly `GODOT_BIN=/opt/homebrew/bin/godot`; confirm it reports `4.7.stable.official.5b4e0cb0f`.
- [ ] Run editor, native, destructive, and end-to-end checks only against disposable fixture copies. Never mutate a real game checkout.
- [ ] Do not change the stdio MCP boundary, loopback binding, grants/packs, trace schema, receipt schema, audit schema, or input event union.
- [ ] Do not add OS-global input suppression or `Viewport.gui_disable_input` to production code. The observed failure establishes an over-broad oracle, not a production delivery defect.
- [ ] Treat the private event metadata only as fixture diagnostic provenance. Do not expose it on the wire, accept it from callers, or use it for authorization.
- [ ] Preserve full `state_digest` coverage for action, key, mouse, touch, gesture, and joypad behavior. Add a separate replay oracle; do not weaken the all-input assertions.
- [ ] Persist only digest values and changed property names in failure artifacts. Never persist action names, keycodes, coordinates, trace payloads, descriptors, or bearer material.
- [ ] Escalation gate: if the reproducer or new evidence shows `replay_digest`, `replay_delivery_order`, `replay_event_count`, `replay_last_kind`, `replay_action_pressed`, or `replay_keycode` drifting for identical traces, stop. Do not land the oracle narrowing; inspect `runtime_input.gd`, `runtime_frame_clock.gd`, scene reload state release, and descriptor/session ordering instead.

---

## Task 1: Add redaction-safe component diagnostics

**Files:**

- Create: `tests/helpers/input-fixture-state.ts`
- Create: `tests/helpers/input-fixture-state.test.ts`
- Modify: `tests/end-to-end/phase-4.test.ts`

- [ ] Write a failing unit test for a helper that requires the fixture's replay fields, projects those values into a typed object, and returns only changed property names for the full diagnostic field set.

```ts
import { describe, expect, test } from "vitest";

import {
  buildInputFixtureFailureEvidence,
  changedInputFixturePropertyNames,
  readInputFixtureReplayState,
  type RuntimeProperty,
} from "./input-fixture-state.js";

const properties = (overrides: Record<string, unknown> = {}): RuntimeProperty[] =>
  Object.entries({
    delivery_order: "action,key,action",
    event_count: 3,
    last_kind: "action",
    action_pressed: false,
    keycode: 67,
    mouse_x: 0,
    mouse_y: 0,
    mouse_button_pressed: false,
    scroll_x: 0,
    scroll_y: 0,
    active_touch_count: 0,
    touch_drag_x: 0,
    touch_drag_y: 0,
    pan_x: 0,
    pan_y: 0,
    magnify_millionths: 0,
    joy_button_pressed: false,
    joy_axis_millionths: 0,
    inherited_reload_key_pressed: false,
    state_digest: "full-a",
    replay_delivery_order: "action,key,action",
    replay_event_count: 3,
    replay_last_kind: "action",
    replay_action_pressed: false,
    replay_keycode: 67,
    replay_digest: "replay-a",
    ...overrides,
  }).map(([name, value]) => ({ name, value }));

describe("input fixture state evidence", () => {
  test("reads the trace-scoped replay state", () => {
    expect(readInputFixtureReplayState(properties())).toEqual({
      digest: "replay-a",
      deliveryOrder: "action,key,action",
      eventCount: 3,
      lastKind: "action",
      actionPressed: false,
      keycode: 67,
    });
  });

  test("reports names without returning sensitive values", () => {
    const first = properties();
    const replayed = properties({ mouse_x: 19, state_digest: "full-b" });
    const changed = changedInputFixturePropertyNames(
      first,
      replayed,
    );
    expect(changed).toEqual(["mouse_x", "state_digest"]);
    const evidence = buildInputFixtureFailureEvidence(first, replayed);
    expect(evidence).toEqual({
      schemaVersion: 1,
      firstReplayDigest: "replay-a",
      replayedReplayDigest: "replay-a",
      changedPropertyNames: ["mouse_x", "state_digest"],
    });
    expect(JSON.stringify(evidence)).not.toContain("19");
    expect(JSON.stringify(evidence)).not.toContain("67");
  });

  test("rejects a missing replay property", () => {
    expect(() => readInputFixtureReplayState(
      properties().filter(({ name }) => name !== "replay_digest"),
    )).toThrow("Missing input fixture property: replay_digest");
  });
});
```

- [ ] Run the helper test and confirm it fails because `tests/helpers/input-fixture-state.ts` does not exist.

```bash
pnpm exec vitest run tests/helpers/input-fixture-state.test.ts
```

Expected: one failed test file with a module-resolution error for `./input-fixture-state.js`.

- [ ] Implement `tests/helpers/input-fixture-state.ts` with these public interfaces and no value-logging behavior.

```ts
export interface RuntimeProperty {
  name: string;
  value: unknown;
}

export interface InputFixtureReplayState {
  digest: string;
  deliveryOrder: string;
  eventCount: number;
  lastKind: string;
  actionPressed: boolean;
  keycode: number;
}

export interface InputFixtureFailureEvidence {
  schemaVersion: 1;
  firstReplayDigest: string | null;
  replayedReplayDigest: string | null;
  changedPropertyNames: string[];
}

const diagnosticPropertyNames = [
  "delivery_order", "event_count", "last_kind", "action_pressed", "keycode",
  "mouse_x", "mouse_y", "mouse_button_pressed", "scroll_x", "scroll_y",
  "active_touch_count", "touch_drag_x", "touch_drag_y", "pan_x", "pan_y",
  "magnify_millionths", "joy_button_pressed", "joy_axis_millionths",
  "inherited_reload_key_pressed", "state_digest", "replay_delivery_order",
  "replay_event_count", "replay_last_kind", "replay_action_pressed",
  "replay_keycode", "replay_digest",
] as const;

function requiredProperty(properties: RuntimeProperty[], name: string): unknown {
  const property = properties.find((entry) => entry.name === name);
  if (!property) throw new Error(`Missing input fixture property: ${name}`);
  return property.value;
}

export function readInputFixtureReplayState(
  properties: RuntimeProperty[],
): InputFixtureReplayState {
  return {
    digest: String(requiredProperty(properties, "replay_digest")),
    deliveryOrder: String(requiredProperty(properties, "replay_delivery_order")),
    eventCount: Number(requiredProperty(properties, "replay_event_count")),
    lastKind: String(requiredProperty(properties, "replay_last_kind")),
    actionPressed: Boolean(requiredProperty(properties, "replay_action_pressed")),
    keycode: Number(requiredProperty(properties, "replay_keycode")),
  };
}

export function changedInputFixturePropertyNames(
  first: RuntimeProperty[],
  replayed: RuntimeProperty[],
): string[] {
  return diagnosticPropertyNames.filter((name) =>
    !Object.is(requiredProperty(first, name), requiredProperty(replayed, name))
  );
}

export function buildInputFixtureFailureEvidence(
  first?: RuntimeProperty[],
  replayed?: RuntimeProperty[],
): InputFixtureFailureEvidence {
  return {
    schemaVersion: 1,
    firstReplayDigest: first ? readInputFixtureReplayState(first).digest : null,
    replayedReplayDigest: replayed ? readInputFixtureReplayState(replayed).digest : null,
    changedPropertyNames: first && replayed
      ? changedInputFixturePropertyNames(first, replayed)
      : [],
  };
}
```

- [ ] Run `pnpm exec vitest run tests/helpers/input-fixture-state.test.ts` and confirm 3/3 tests pass.

- [ ] Extend `preserveFailureReceipts()` in `tests/end-to-end/phase-4.test.ts` to accept optional first/replayed property arrays. Write `phase-4-end-to-end-state.json` with exactly this redacted shape:

```ts
await writeFile(
  join(directory, "phase-4-end-to-end-state.json"),
  `${JSON.stringify(buildInputFixtureFailureEvidence(firstProperties, replayedProperties))}\n`,
  "utf8",
);
```

Define `firstProperties` and `replayedProperties` outside the test's `try` block so the catch path can pass them to the artifact writer. Keep `frame_counter` out of the diagnostic list because elapsed frames are expected to differ.

- [ ] Keep the helper test's assertions that serialized evidence contains neither the raw keycode `67` nor coordinate value `19`. Do not place raw property maps in JSON artifacts or thrown error text.

- [ ] Run focused TypeScript checks.

```bash
pnpm exec vitest run tests/helpers/input-fixture-state.test.ts
pnpm exec eslint tests/helpers/input-fixture-state.ts tests/helpers/input-fixture-state.test.ts tests/end-to-end/phase-4.test.ts
pnpm typecheck
```

Expected: helper tests pass, ESLint exits 0, and all workspace typechecks pass.

- [ ] Commit the diagnostic layer.

```bash
git add tests/helpers/input-fixture-state.ts tests/helpers/input-fixture-state.test.ts tests/end-to-end/phase-4.test.ts
git commit -m "test: add Phase 4 replay drift evidence"
```

---

## Task 2: Split full fixture state from trace-scoped replay state

**Files:**

- Modify: `fixtures/godot-4.7/input/input_fixture.gd`
- Modify: `fixtures/godot-4.7/tests/runtime_input_unit.gd`

- [ ] In `runtime_input_unit.gd`, instantiate `res://input/input_fixture.tscn`, deliver action/key/action directly to its `_input()` callback, then deliver mouse motion and a released reset key. Add assertions with this contract before adding fixture support:

```gdscript
var fixture_scene := load("res://input/input_fixture.tscn") as PackedScene
var fixture := fixture_scene.instantiate()
root.add_child(fixture)
await process_frame

fixture._input(action.events[0])
fixture._input(key.events[0])
var action_release: Dictionary = EventFactory.build({
	"type": "action", "action": "phase_4_accept", "pressed": false,
	"strengthMillionths": 0,
})
fixture._input(action_release.events[0])
assert(fixture.replay_delivery_order == "action,key,action")
assert(fixture.replay_event_count == 3)
assert(fixture.replay_last_kind == "action")
assert(not fixture.replay_action_pressed and fixture.replay_keycode == 65)

var replay_digest_before_noise: String = fixture.replay_digest
var full_digest_before_noise: String = fixture.state_digest
fixture._input(mouse.events[0])
assert(fixture.state_digest != full_digest_before_noise)
assert(fixture.replay_digest == replay_digest_before_noise)

var reset_release := InputEventKey.new()
reset_release.keycode = KEY_R
reset_release.pressed = false
fixture._input(reset_release)
assert(fixture.replay_digest == replay_digest_before_noise)
fixture.queue_free()
await process_frame
```

- [ ] Run the authoritative Phase 4 gate and confirm the native fixture stage fails on missing `replay_*` properties. Capture only the failing stage name; do not preserve an unredacted runtime log.

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-4
```

Expected: the GDScript input unit stage fails before the final `GODOT_MCP_RUNTIME_INPUT_UNIT_OK` marker.

- [ ] Add these exported fields to `input_fixture.gd` without altering the existing fields or `_refresh_digest()` inputs:

```gdscript
@export var replay_delivery_order := ""
@export var replay_event_count := 0
@export var replay_last_kind := ""
@export var replay_action_pressed := false
@export var replay_keycode := 0
@export var replay_digest := ""
```

- [ ] Add a trace-scoped recorder and digest. Call `_refresh_replay_digest()` from `_ready()`.

```gdscript
func _record_replay(kind: String) -> void:
	replay_last_kind = kind
	replay_event_count += 1
	replay_delivery_order = kind if replay_delivery_order.is_empty() else "%s,%s" % [replay_delivery_order, kind]
	_refresh_replay_digest()

func _refresh_replay_digest() -> void:
	replay_digest = JSON.stringify([
		replay_delivery_order, replay_event_count, replay_last_kind,
		replay_action_pressed, replay_keycode,
	]).sha256_text()
```

- [ ] Update only the accepted action and non-reset key branches:

```gdscript
if event is InputEventAction and String(event.action) == "phase_4_accept":
	action_pressed = event.pressed
	_record("action")
	replay_action_pressed = event.pressed
	_record_replay("action")
elif event is InputEventKey:
	keycode = int(event.keycode)
	_record("key")
	if event.keycode != KEY_R:
		replay_keycode = int(event.keycode)
		_record_replay("key")
	if event.pressed and event.keycode == KEY_R:
		call_deferred("_reload_scene")
```

The reset key remains visible in the broad state but is excluded from the post-reload replay oracle. Non-reset key releases remain included so leaked held-state cleanup is still detectable.

- [ ] Re-run `GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-4`. Confirm all 14 stages pass, including the native success marker, and that the fixture diff/residue checks remain zero.

- [ ] Apply the escalation gate to the results. If mouse/reset noise changes any `replay_*` field, stop and investigate rather than modifying the assertions. If only broad fields and `state_digest` change, continue.

- [ ] Commit the fixture split.

```bash
git add fixtures/godot-4.7/input/input_fixture.gd fixtures/godot-4.7/tests/runtime_input_unit.gd
git commit -m "test: isolate the Phase 4 replay oracle"
```

---

## Task 3: Make E2E and integration replay assertions trace-scoped

**Files:**

- Modify: `tests/end-to-end/phase-4.test.ts`
- Modify: `tests/integration/runtime-input.test.ts`
- Test: `tests/helpers/input-fixture-state.test.ts`

- [ ] In the E2E test, read `firstReplayState` immediately after the realtime sequence and assert the trace-controlled state exactly:

```ts
const firstReplayState = readInputFixtureReplayState(firstProperties);
expect(firstReplayState).toMatchObject({
  deliveryOrder: "action,key,action",
  eventCount: 3,
  lastKind: "action",
  actionPressed: false,
  keycode: 67,
});
expect(firstReplayState.digest).toMatch(/^[a-f0-9]{64}$/);
```

- [ ] Change the scene-reload wait from broad `event_count === 0` to `replay_event_count === 0`, retain `frame_counter > 0`, and require `inherited_reload_key_pressed === false`. This allows harmless mouse movement while continuing to detect inherited reset-key state.

- [ ] After replay, compare `readInputFixtureReplayState(replayedProperties)` to `firstReplayState`. Retain the receipt checks and add exact delivered frames:

```ts
expect(replay.structuredContent).toMatchObject({
  ok: true,
  data: {
    receipt: {
      deterministic: true,
      deliveredCount: 3,
      events: [
        { deliveredFrame: 0 },
        { deliveredFrame: 1 },
        { deliveredFrame: 2 },
      ],
    },
  },
});
expect(readInputFixtureReplayState(replayedProperties)).toEqual(firstReplayState);
```

Do not delete the earlier broad input-family assertions from `runtime-input.test.ts`; they remain the coverage for `state_digest` components.

- [ ] In the integration test's two fresh deterministic runs, replace `{ digest: state_digest, order: delivery_order }` with the complete return of `readInputFixtureReplayState(after.properties)`. Keep `frameDelta` and `deliveredFrames` in the equality comparison.

```ts
deterministicRuns.push({
  replayState: readInputFixtureReplayState(after.properties),
  frameDelta: Number(afterProperty("frame_counter")) - beforeFrame,
  deliveredFrames: replayed.receipt.events.map((event) => event.deliveredFrame),
});
```

- [ ] Change the integration reset wait to `replay_event_count === 0`, `frame_counter > 0`, and `inherited_reload_key_pressed === false` for the same reason as E2E.

- [ ] Run the focused helper, integration, and E2E tests serially.

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm exec vitest run \
  tests/helpers/input-fixture-state.test.ts \
  tests/integration/runtime-input.test.ts \
  tests/end-to-end/phase-4.test.ts \
  --fileParallelism=false
```

Expected: all selected tests pass; the E2E receipt reports frames `[0, 1, 2]`; both fresh integration runs have identical replay state and frame deltas.

- [ ] Run the exact E2E 25 times to turn the former intermittent failure into a release check.

```bash
for run in {1..25}; do
  echo "Phase 4 replay stress ${run}/25"
  GODOT_BIN=/opt/homebrew/bin/godot pnpm exec vitest run \
    tests/end-to-end/phase-4.test.ts --fileParallelism=false || exit 1
done
```

Expected: 25/25 runs pass. A single failure is red; preserve the redacted `phase-4-end-to-end-state.json`, apply the escalation gate, and do not retry it away.

- [ ] Run lint and typecheck after the assertion changes.

```bash
pnpm exec eslint tests/helpers/input-fixture-state.ts tests/helpers/input-fixture-state.test.ts tests/integration/runtime-input.test.ts tests/end-to-end/phase-4.test.ts
pnpm typecheck
```

Expected: both commands exit 0.

- [ ] Commit the trace-scoped assertions.

```bash
git add tests/end-to-end/phase-4.test.ts tests/integration/runtime-input.test.ts
git commit -m "test: harden Phase 4 deterministic replay"
```

---

## Task 3A: Accepted review amendment — exclude ambient keys by provenance

**Files:**

- Modify: `addons/godot_mcp/runtime/runtime_input_event_factory.gd`
- Modify: `fixtures/godot-4.7/input/input_fixture.gd`
- Modify: `fixtures/godot-4.7/tests/runtime_input_unit.gd`

- [x] Autoreview identified that filtering mouse and reset-key events was insufficient because ambient non-reset keyboard input could still mutate the replay digest.
- [x] Add an untagged ambient key between factory-built events in the native fixture test and verify the replay-order assertion fails.
- [x] Mark every event produced by the closed factory with private `_godot_mcp_injected_v1` metadata. Do not add a wire field or allow caller-controlled provenance.
- [x] Update only the fixture replay recorder to require that marker; retain every event in the broad state.
- [x] Verify `GODOT_MCP_RUNTIME_INPUT_UNIT_OK` and the real integration/E2E path, proving metadata survives both `Input.parse_input_event()` and viewport delivery.
- [x] Re-run the 25/25 E2E stress and structured autoreview after this amendment.

---

## Task 4: Document the determinism boundary and certify release readiness

**Files:**

- Modify: `docs/testing/phase-4.md`
- Modify: `docs/protocol/bridge-v1.md`
- Modify: `docs/security/threat-model.md`
- Include in docs commit: `docs/superpowers/plans/2026-07-21-phase-4-determinism-flake.md`

- [ ] Update `docs/testing/phase-4.md` under **Deterministic replay** with this contract:

```md
Deterministic receipts certify the schedule of MCP-injected events; they do not suppress or record concurrent platform input delivered to a windowed Godot runtime. Release replay comparisons therefore use the fixture's trace-scoped action/key digest and exact delivered frames. The fixture's separate all-input digest continues to certify mouse, touch, gesture, and joypad handling. Failure evidence records digest values and changed property names only, never raw action names, keycodes, coordinates, or trace payloads.
```

- [ ] Update the deterministic paragraph in `docs/protocol/bridge-v1.md` to state that recording observes only MCP-injected events and deterministic replay does not claim to exclude ambient platform events. Do not change any normative operation, payload, trace, receipt, or error schema.

- [ ] Update the `Nondeterministic replay claims` mitigation in `docs/security/threat-model.md` to add the trace-scoped release oracle and redaction-safe changed-field diagnostics.

- [ ] Verify the wording against the Godot 4.7 primary references for [`Input.parse_input_event()`](https://docs.godotengine.org/en/4.7/classes/class_input.html#class-input-method-parse-input-event), [`Viewport.push_input()`](https://docs.godotengine.org/en/4.7/classes/class_viewport.html#class-viewport-method-push-input), [input event flow](https://docs.godotengine.org/en/stable/tutorials/inputs/inputevent.html), and [paused processing](https://docs.godotengine.org/en/stable/tutorials/scripting/pausing_games.html). Do not claim Godot provides isolation that the implementation does not enable.

- [ ] Review the complete diff before release gates.

```bash
git diff --check
git status --short
git diff --stat 3fd0bea...HEAD
git diff 3fd0bea...HEAD -- \
  fixtures/godot-4.7/input/input_fixture.gd \
  fixtures/godot-4.7/tests/runtime_input_unit.gd \
  tests/helpers/input-fixture-state.ts \
  tests/helpers/input-fixture-state.test.ts \
  tests/integration/runtime-input.test.ts \
  tests/end-to-end/phase-4.test.ts \
  docs/testing/phase-4.md docs/protocol/bridge-v1.md docs/security/threat-model.md
```

Expected: no whitespace errors; the only production addon change is the internal event-factory provenance marker; no protocol, receipt, grant, runtime-service, or frame-clock change; no secret or raw input values in evidence-writing code.

- [ ] Commit the documentation and this plan.

```bash
git add docs/testing/phase-4.md docs/protocol/bridge-v1.md docs/security/threat-model.md \
  docs/superpowers/plans/2026-07-21-phase-4-determinism-flake.md
git commit -m "docs: define the Phase 4 replay boundary"
```

- [ ] Run the mandatory Phase 0-4 gates in order. Do not call an environment skip a pass.

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-0-1
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-2
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-3
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-4
```

Expected: every stage in every gate passes, including native success markers, full regression counts, disposable fixture diff checks, and residue checks.

- [ ] Run the complete release gate once after the focused stress and mandatory regressions.

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-11
```

Expected: Phase 11 passes all 15 stages and all tests. Both eight-artifact release builds are byte-reproducible, the approved baseline digest matches its manifest, town source/index hashes are unchanged, and all temporary project/user-data paths are absent afterward.

- [ ] Record a final evidence receipt containing: baseline commit, implementation commits, focused test counts, `25/25` stress result, Phase 0-4 stage counts, Phase 11 `15/15` and test count, release artifact digests, source/index/dirty-state hashes, residue scan, and final worktree status. Explicitly record any failure even if a later retry passes.

- [ ] Confirm `git status --short --branch` is clean. If a QA artifact remains, inspect it before removal and use only the repository's documented cleanup path; do not use broad recursive deletion.

## Release Decision

Release is green only when all of the following are true:

- The fixture unit proves unrelated mouse/reset input changes the broad state without changing the trace-scoped replay state.
- The exact Phase 4 E2E passes 25/25 with no suppressed failure.
- No replay-controlled field appears in a drift artifact for identical traces.
- Phase 0-4 and Phase 11 pass without environment skips.
- Source hashes, approved visual baseline, reproducible release artifacts, cleanup residue, and final worktree cleanliness all match their expected receipts.

Any replay-controlled drift or any failed stress iteration keeps the pre-release risk open and redirects the work to production runtime/input lifecycle diagnosis.
