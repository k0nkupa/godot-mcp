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
      {
        successMarker: "PHASE6_SOURCE_UNIT_OK",
        failureLine: /^SCRIPT ERROR: Parse Error: Expected closing parenthesis$/,
        companionFailureLine: /^(?:ERROR: )?Failed to load script .+ with error Parse error\.$/,
      },
    )).toBe(false);
  });

  it("allows Godot's companion load diagnostic after an expected parser failure", () => {
    expect(hasUnexpectedGodotScriptFailure(
      "Godot Engine\nPHASE6_SOURCE_UNIT_OK\n",
      "SCRIPT ERROR: Parse Error: Expected closing parenthesis\nERROR: Failed to load script res://authoring/broken.gd with error Parse error.\n",
      {
        successMarker: "PHASE6_SOURCE_UNIT_OK",
        failureLine: /^SCRIPT ERROR: Parse Error: Expected closing parenthesis$/,
        companionFailureLine: /^(?:ERROR: )?Failed to load script .+ with error Parse error\.$/,
      },
    )).toBe(false);
  });

  it("does not let a success marker hide an unrelated script failure", () => {
    expect(hasUnexpectedGodotScriptFailure(
      "Godot Engine\nPHASE6_SOURCE_UNIT_OK\n",
      "SCRIPT ERROR: Parse Error: Expected closing parenthesis\nSCRIPT ERROR: Invalid call in unrelated.gd\n",
      { successMarker: "PHASE6_SOURCE_UNIT_OK", failureLine: /^SCRIPT ERROR: Parse Error: Expected closing parenthesis$/ },
    )).toBe(true);
  });

  it("accepts output without script failures", () => {
    expect(hasUnexpectedGodotScriptFailure("PHASE7_PROFILER_UNIT_OK\n", "")).toBe(false);
  });
});
