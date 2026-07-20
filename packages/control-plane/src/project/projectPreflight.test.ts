import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { copyFixture } from "@godot-mcp/testkit";
import { expect, it } from "vitest";

import { assertBuildSolutionsPreflight, assertExportPreflight } from "./projectPreflight.js";

it("requires a supported scripting solution before build-solutions", async () => {
  const project = await copyFixture();
  try {
    await expect(assertBuildSolutionsPreflight(project.root)).rejects.toThrow(/\.sln or \.csproj/i);
    await writeFile(join(project.root, "fixture.csproj"), "<Project />");
    await expect(assertBuildSolutionsPreflight(project.root)).resolves.toBeUndefined();
  } finally { await project.cleanup(); }
});

it("requires an existing preset with an explicit Godot MCP exclusion", async () => {
  const project = await copyFixture();
  try {
    await writeFile(join(project.root, "export_presets.cfg"), '[preset.0]\nname="Safe"\nexclude_filter="addons/godot_mcp/**"\n');
    await expect(assertExportPreflight(project.root, "Safe")).resolves.toBeUndefined();
    await expect(assertExportPreflight(project.root, "Missing")).rejects.toThrow(/does not exist/i);
    await writeFile(join(project.root, "export_presets.cfg"), '[preset.0]\nname="Unsafe"\nexclude_filter=""\n');
    await expect(assertExportPreflight(project.root, "Unsafe")).rejects.toThrow(/must exclude/i);
  } finally { await project.cleanup(); }
});
