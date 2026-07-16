import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectStdio: vi.fn(async () => undefined),
  createRuntime: vi.fn(),
  runDoctor: vi.fn(async () => ({ healthy: true, checks: [] })),
}));

vi.mock("@godot-mcp/mcp-server", () => ({ connectStdio: mocks.connectStdio }));
vi.mock("../install/doctor.js", () => ({ runDoctor: mocks.runDoctor }));
vi.mock("../runtime/createRuntime.js", () => ({ createRuntime: mocks.createRuntime }));

import { connectProject, parseConnectGrants } from "./connect.js";

describe("connect grants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createRuntime.mockResolvedValue({
      project: { projectId: "019f644c-1379-79c0-825e-66a4b7653bd1" },
      bridge: { port: 12345 },
      mcp: {},
      close: async () => undefined,
    });
  });
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

  it("forwards the explicitly selected Godot binary to runtime launch", async () => {
    const grants = parseConnectGrants(["runtime_control"], ["runtime"]);
    await connectProject("/private/project", grants, "/custom/godot");
    expect(mocks.runDoctor).toHaveBeenCalledWith("/private/project", "/custom/godot");
    expect(mocks.createRuntime).toHaveBeenCalledWith({ project: "/private/project", grants, godotBin: "/custom/godot" });
  });
});
