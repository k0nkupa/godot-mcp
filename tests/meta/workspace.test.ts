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

  it("defines the ordered Phase 4 certification gate and current documentation", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.["qa:phase-4"]).toBe("node scripts/qa-phase-4.mjs");

    const gate = await readFile("scripts/qa-phase-4.mjs", "utf8");
    expect(gate).toContain("4.7.stable.official.5b4e0cb0f");
    for (let stage = 1; stage <= 14; stage += 1) expect(gate).toContain(`${stage}/14`);
    expect(gate).toContain("tests/integration/runtime-input.test.ts");
    expect(gate).toContain("tests/security/input-hostile.test.ts");
    expect(gate).toContain("tests/end-to-end/phase-4.test.ts");
    expect(gate).toContain("await rm(failureArtifacts, { force: true, recursive: true })");

    const readme = await readFile("README.md", "utf8");
    expect(readme).toContain("pnpm qa:phase-4");
    expect(readme).toContain("--grant runtime_control --pack runtime --pack input");
  });

  it("defines the ordered Phase 5 certification gate and editor mutation documentation", async () => {
	const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { scripts?: Record<string, string> };
	expect(packageJson.scripts?.["qa:phase-5"]).toBe("node scripts/qa-phase-5.mjs");
	const gate = await readFile("scripts/qa-phase-5.mjs", "utf8");
	expect(gate).toContain("4.7.stable.official.5b4e0cb0f");
	for (let stage = 1; stage <= 13; stage += 1) expect(gate).toContain(`${stage}/13`);
	expect(gate).toContain("tests/integration/editor-mutation.test.ts");
	expect(gate).toContain("tests/security/editor-mutation-hostile.test.ts");
	expect(gate).toContain("tests/end-to-end/phase-5.test.ts");
	const readme = await readFile("README.md", "utf8");
	expect(readme).toContain("pnpm qa:phase-5");
	expect(readme).toContain("--grant project_mutate --pack editor");
	expect(await readFile("docs/testing/phase-5.md", "utf8")).toContain("godot_editor");
  });

  it("defines the ordered Phase 6 certification gate and authoring documentation", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.["qa:phase-6"]).toBe("node scripts/qa-phase-6.mjs");
    const gate = await readFile("scripts/qa-phase-6.mjs", "utf8");
    expect(gate).toContain("4.7.stable.official.5b4e0cb0f");
    for (let stage = 1; stage <= 15; stage += 1) expect(gate).toContain(`${stage}/15`);
    expect(gate).toContain("tests/integration/editor-authoring.test.ts");
    expect(gate).toContain("tests/security/editor-authoring-hostile.test.ts");
    expect(gate).toContain("tests/end-to-end/phase-6.test.ts");
    expect(gate).toContain("scripts/verify-phase-6-cleanup.mjs");
    expect(await readFile("docs/superpowers/plans/2026-07-17-phase-6-complete-authoring-surface.md", "utf8")).toContain("Phase 6");
    expect(await readFile("README.md", "utf8")).toContain("pnpm qa:phase-6");
    expect(await readFile("docs/testing/phase-6.md", "utf8")).toContain("create_script");
  });

  it("defines the ordered Phase 7 certification gate and debugging documentation", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.["qa:phase-7"]).toBe("node scripts/qa-phase-7.mjs");
    const gate = await readFile("scripts/qa-phase-7.mjs", "utf8");
    expect(gate).toContain("4.7.stable.official.5b4e0cb0f");
    for (let stage = 1; stage <= 16; stage += 1) expect(gate).toContain(`${stage}/16`);
    expect(gate).toContain("runtime_profiler_unit.gd");
    expect(gate).toContain("tests/integration/runtime-debugging.test.ts");
    expect(gate).toContain("tests/security/runtime-debugging-hostile.test.ts");
    expect(gate).toContain("tests/end-to-end/phase-7.test.ts");
    expect(gate).toContain("scripts/verify-phase-7-cleanup.mjs");
    expect(gate).toContain('readOutput("git", ["status", "--porcelain=v1", "--untracked-files=all"]');
    const agents = await readFile("AGENTS.md", "utf8");
    expect(agents).toContain("docs/superpowers/plans/2026-07-17-phase-7-debugging-performance.md");
    expect(agents).toContain("docs/testing/phase-7.md");
    expect(await readFile("README.md", "utf8")).toContain("pnpm qa:phase-7");
    expect(await readFile("docs/testing/phase-7.md", "utf8")).toContain("debug_breakpoints_set");
  });
});
