import { describe, expect, it } from "vitest";

import { hasUnexpectedGodotScriptFailure } from "./godot.js";

describe("Godot script result detection", () => {
  it("rejects silent script failures even when Godot exits zero", () => {
    expect(hasUnexpectedGodotScriptFailure("Godot Engine\n", "SCRIPT ERROR: Parse Error\nFailed to load script\n")).toBe(true);
  });

  it("allows hostile-input units that explicitly certify an expected parser failure", () => {
    expect(hasUnexpectedGodotScriptFailure(
      "Godot Engine\nPHASE6_SOURCE_UNIT_OK\n",
      "SCRIPT ERROR: Parse Error: Expected closing parenthesis\n",
    )).toBe(false);
  });

  it("accepts output without script failures", () => {
    expect(hasUnexpectedGodotScriptFailure("PHASE7_PROFILER_UNIT_OK\n", "")).toBe(false);
  });
});
