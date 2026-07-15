import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const names = [
  "protocol",
  "control-plane",
  "bridge-client",
  "mcp-server",
  "cli",
  "testkit",
] as const;

describe("workspace package contract", () => {
  it.each(names)("defines @godot-mcp/%s at product version 0.1.0", async (name) => {
    const json = JSON.parse(await readFile(`packages/${name}/package.json`, "utf8")) as unknown;

    expect(json).toMatchObject({
      name: `@godot-mcp/${name}`,
      version: "0.1.0",
      type: "module",
    });
  });

  it("defines the ordered Phase 3 certification gate and current documentation", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.["qa:phase-3"]).toBe("node scripts/qa-phase-3.mjs");

    const gate = await readFile("scripts/qa-phase-3.mjs", "utf8");
    expect(gate).toContain("4.7.stable.official.5b4e0cb0f");
    for (let stage = 1; stage <= 15; stage += 1) expect(gate).toContain(`${stage}/15`);
    expect(gate).toContain("tests/integration/runtime-bridge.test.ts");
    expect(gate).toContain("tests/security/runtime-hostile.test.ts");
    expect(gate).toContain("tests/end-to-end/phase-3.test.ts");
    expect(gate).toContain("await rm(failureArtifacts, { force: true, recursive: true })");

    const agents = await readFile("AGENTS.md", "utf8");
    expect(agents).toContain("docs/superpowers/plans/2026-07-16-phase-3-ephemeral-runtime-bridge.md");
    expect(agents).toContain("docs/testing/phase-3.md");
    const readme = await readFile("README.md", "utf8");
    expect(readme).toContain("pnpm qa:phase-3");
    expect(readme).toContain("--grant runtime_control --pack runtime");
  });
});
