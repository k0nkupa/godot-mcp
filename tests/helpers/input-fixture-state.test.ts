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
    expect(changedInputFixturePropertyNames(first, replayed)).toEqual(["mouse_x", "state_digest"]);

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

  test("returns empty evidence when fixture reads are unavailable", () => {
    expect(buildInputFixtureFailureEvidence()).toEqual({
      schemaVersion: 1,
      firstReplayDigest: null,
      replayedReplayDigest: null,
      changedPropertyNames: [],
    });
  });

  test("preserves broad changed-field evidence before replay fields exist", () => {
    const withoutReplayFields = (values: RuntimeProperty[]): RuntimeProperty[] =>
      values.filter(({ name }) => !name.startsWith("replay_"));

    expect(buildInputFixtureFailureEvidence(
      withoutReplayFields(properties()),
      withoutReplayFields(properties({ mouse_y: 23, state_digest: "full-b" })),
    )).toEqual({
      schemaVersion: 1,
      firstReplayDigest: null,
      replayedReplayDigest: null,
      changedPropertyNames: ["mouse_y", "state_digest"],
    });
  });

  test("rejects a missing replay property", () => {
    expect(() => readInputFixtureReplayState(
      properties().filter(({ name }) => name !== "replay_digest"),
    )).toThrow("Missing input fixture property: replay_digest");
  });
});
