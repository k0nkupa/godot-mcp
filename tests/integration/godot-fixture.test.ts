import { expect, test } from "vitest";

import { runGodot } from "@godot-mcp/testkit";

test("Godot 4.7 fixture parses and runs", async () => {
  const result = await runGodot([
    "--headless",
    "--path",
    "fixtures/godot-4.7",
    "--script",
    "res://tests/fixture_smoke.gd",
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("GODOT_MCP_FIXTURE_OK");
});
