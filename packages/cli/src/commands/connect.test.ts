import { describe, expect, it } from "vitest";

import { parseConnectGrants } from "./connect.js";

describe("connect grants", () => {
  it("keeps the default session observe-only", () => {
    expect(parseConnectGrants([], [])).toEqual({ tiers: ["observe"], packs: ["core"] });
  });

  it("requires the runtime tier and pack together", () => {
    expect(parseConnectGrants(["runtime_control"], ["runtime"])).toEqual({
      tiers: ["observe", "runtime_control"],
      packs: ["core", "runtime"],
    });
    expect(() => parseConnectGrants(["runtime_control"], [])).toThrow("must be granted together");
    expect(() => parseConnectGrants([], ["runtime"])).toThrow("must be granted together");
    expect(() => parseConnectGrants(["project_mutate"], ["runtime"])).toThrow("Unsupported connect grant");
  });
});
