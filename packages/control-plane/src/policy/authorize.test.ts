import { describe, expect, it } from "vitest";

import {
  authorize,
  CORE_SESSION_POLICY,
  expandPermissionTiers,
  visibleCapabilities,
} from "../index.js";

describe("authorization policy", () => {
  it("allows a core read with observe only", () => {
    expect(authorize({ tiers: ["observe"], packs: ["core"] }, CORE_SESSION_POLICY)).toEqual({
      allowed: true,
    });
  });

  it("denies project mutation without both tier and pack", () => {
    expect(() =>
      authorize(
        { tiers: ["observe", "project_mutate"], packs: ["core"] },
        { command: "editor.batch", tier: "project_mutate", pack: "editor", mutating: true },
      ),
    ).toThrowError(expect.objectContaining({ code: "PERMISSION_REQUIRED" }));
  });

  it("uses an explicit cumulative tier map without implying unsafe access", () => {
    expect(expandPermissionTiers(["project_operate"])).toEqual([
      "observe",
      "runtime_control",
      "project_mutate",
      "project_operate",
    ]);
    expect(expandPermissionTiers(["project_operate"])).not.toContain("unsafe_fixture");
  });

  it("shows only capabilities authorized by both tier and pack", () => {
    expect(visibleCapabilities({ tiers: ["observe"], packs: ["core"] }).map((item) => item.command)).toEqual([
      "godot_capabilities",
      "godot_doctor",
      "godot_help",
      "godot_session",
    ]);
    expect(visibleCapabilities({ tiers: ["observe"], packs: [] })).toEqual([]);
  });
});
