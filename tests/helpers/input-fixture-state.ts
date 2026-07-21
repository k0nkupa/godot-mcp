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

function findProperty(properties: RuntimeProperty[], name: string): RuntimeProperty | undefined {
  return properties.find((entry) => entry.name === name);
}

function requiredProperty(properties: RuntimeProperty[], name: string): unknown {
  const property = findProperty(properties, name);
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

function availableChangedPropertyNames(
  first: RuntimeProperty[],
  replayed: RuntimeProperty[],
): string[] {
  return diagnosticPropertyNames.filter((name) => {
    const firstProperty = findProperty(first, name);
    const replayedProperty = findProperty(replayed, name);
    return firstProperty && replayedProperty
      ? !Object.is(firstProperty.value, replayedProperty.value)
      : false;
  });
}

function replayDigest(properties?: RuntimeProperty[]): string | null {
  if (!properties) return null;
  const property = findProperty(properties, "replay_digest");
  return property ? String(property.value) : null;
}

export function buildInputFixtureFailureEvidence(
  first?: RuntimeProperty[],
  replayed?: RuntimeProperty[],
): InputFixtureFailureEvidence {
  return {
    schemaVersion: 1,
    firstReplayDigest: replayDigest(first),
    replayedReplayDigest: replayDigest(replayed),
    changedPropertyNames: first && replayed
      ? availableChangedPropertyNames(first, replayed)
      : [],
  };
}
