import { describe, expect, it } from "vitest";

import {
  authorize,
  CORE_SESSION_POLICY,
  expandPermissionTiers,
  EDITOR_POLICY,
  INPUT_POLICY,
  PROJECT_POLICY,
  VISUAL_POLICY,
  RUNTIME_CAPTURE_POLICY,
  RUNTIME_POLICY,
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
    expect(
      visibleCapabilities({ tiers: ["observe"], packs: ["core"] })
        .map((item) => item.command)
        .sort(),
    ).toEqual([
      "godot_capabilities",
      "godot_capture",
      "godot_doctor",
      "godot_help",
      "godot_query",
      "godot_session",
    ]);
    expect(visibleCapabilities({ tiers: ["observe"], packs: [] })).toEqual([]);
    expect(
      visibleCapabilities({
        tiers: ["observe", "runtime_control"],
        packs: ["core", "runtime"],
      })
        .map((item) => item.command)
        .sort(),
    ).toEqual([
      "godot_capabilities",
      "godot_capture",
      "godot_doctor",
      "godot_help",
      "godot_query",
      "godot_runtime",
      "godot_runtime_capture",
      "godot_session",
    ]);
    expect(() => authorize({ tiers: ["observe"], packs: ["core", "runtime"] }, RUNTIME_POLICY)).toThrowError(expect.objectContaining({ code: "PERMISSION_REQUIRED" }));
    expect(() => authorize({ tiers: ["observe", "runtime_control"], packs: ["core"] }, RUNTIME_CAPTURE_POLICY)).toThrowError(expect.objectContaining({ code: "PERMISSION_REQUIRED" }));
    expect(RUNTIME_POLICY.mutating).toBe(true);
    expect(RUNTIME_CAPTURE_POLICY.mutating).toBe(true);
  });

  it("requires the input pack independently from runtime launch tools", () => {
    expect(
      visibleCapabilities({
        tiers: ["observe", "runtime_control"],
        packs: ["core", "input"],
      }).map((item) => item.command).sort(),
    ).toEqual([
      "godot_capabilities",
      "godot_capture",
      "godot_doctor",
      "godot_help",
      "godot_input",
      "godot_query",
      "godot_session",
    ]);
    expect(() => authorize(
      { tiers: ["observe", "runtime_control"], packs: ["core", "runtime"] },
      INPUT_POLICY,
    )).toThrowError(expect.objectContaining({ code: "PERMISSION_REQUIRED" }));
    expect(INPUT_POLICY).toEqual({
      command: "godot_input",
      tier: "runtime_control",
      pack: "input",
      mutating: true,
    });
  });

  it("requires project_mutate and editor independently", () => {
    expect(visibleCapabilities({
      tiers: ["observe", "project_mutate"],
      packs: ["core", "editor"],
    }).map((item) => item.command).sort()).toEqual([
      "godot_capabilities",
      "godot_capture",
      "godot_doctor",
      "godot_editor",
      "godot_help",
      "godot_query",
      "godot_session",
    ]);
    expect(visibleCapabilities({ tiers: ["observe"], packs: ["core", "editor"] })
      .map((item) => item.command)).not.toContain("godot_editor");
    expect(visibleCapabilities({ tiers: ["observe", "project_mutate"], packs: ["core"] })
      .map((item) => item.command)).not.toContain("godot_editor");
    expect(EDITOR_POLICY).toEqual({
      command: "godot_editor",
      tier: "project_mutate",
      pack: "editor",
      mutating: true,
    });
  });

  it("requires runtime, input, and visual together for visual QA", () => {
    for (const packs of [
      ["core", "visual"],
      ["core", "runtime", "visual"],
      ["core", "input", "visual"],
    ] as const) {
      expect(() => authorize({ tiers: ["observe", "runtime_control"], packs: [...packs] }, VISUAL_POLICY))
        .toThrowError(expect.objectContaining({ code: "PERMISSION_REQUIRED" }));
      expect(visibleCapabilities({ tiers: ["observe", "runtime_control"], packs: [...packs] }).map((item) => item.command))
        .not.toContain("godot_visual");
    }
    const grants = { tiers: ["observe", "runtime_control"] as const, packs: ["core", "runtime", "input", "visual"] as const };
    expect(authorize({ tiers: [...grants.tiers], packs: [...grants.packs] }, VISUAL_POLICY)).toEqual({ allowed: true });
    expect(visibleCapabilities({ tiers: [...grants.tiers], packs: [...grants.packs] }).map((item) => item.command)).toContain("godot_visual");
  });

  it("requires project_operate and project independently", () => {
    expect(() => authorize({ tiers: ["observe", "project_operate"], packs: ["core"] }, PROJECT_POLICY))
      .toThrowError(expect.objectContaining({ code: "PERMISSION_REQUIRED" }));
    expect(() => authorize({ tiers: ["observe"], packs: ["core", "project"] }, PROJECT_POLICY))
      .toThrowError(expect.objectContaining({ code: "PERMISSION_REQUIRED" }));
    expect(authorize({ tiers: ["observe", "project_operate"], packs: ["core", "project"] }, PROJECT_POLICY))
      .toEqual({ allowed: true });
    expect(visibleCapabilities({ tiers: ["observe", "project_operate"], packs: ["core", "project"] }).map((item) => item.command))
      .toContain("godot_project");
  });
});
