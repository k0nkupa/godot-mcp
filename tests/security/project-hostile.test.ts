import { rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ArtifactStore, PROJECT_POLICY, authorize } from "@godot-mcp/control-plane";
import { ProjectOperationInputSchema } from "@godot-mcp/protocol";
import { copyFixture } from "@godot-mcp/testkit";
import { expect, it } from "vitest";

it("rejects project-operation permission, path, value, token, and executable expansion attacks", () => {
  expect(() => authorize({ tiers: ["observe"], packs: ["core", "project"] }, PROJECT_POLICY)).toThrow();
  expect(() => authorize({ tiers: ["observe", "project_operate"], packs: ["core", "project"] }, PROJECT_POLICY)).not.toThrow();
  for (const value of ["file:///tmp/secret", "https://attacker.invalid", "/etc/passwd", "C:\\secret"]) {
    expect(() => ProjectOperationInputSchema.parse({ operation: "settings_apply", idempotencyKey: crypto.randomUUID(), changes: [{ name: "application/config/name", value }] })).toThrow();
  }
  expect(() => ProjectOperationInputSchema.parse({ operation: "plugin_set", idempotencyKey: crypto.randomUUID(), pluginPath: "res://addons/godot_mcp/plugin.cfg", expectedEnabled: true, enabled: false })).toThrow();
  expect(() => ProjectOperationInputSchema.parse({ operation: "run_start", headless: true, arguments: ["--script", "evil.gd"] })).toThrow();
  expect(() => ProjectOperationInputSchema.parse({ operation: "job_status", jobToken: "pjob_predictable" })).toThrow();
});

it("fails closed on artifact symlinks and split MCP markers", async () => {
  const project = await copyFixture();
  const store = new ArtifactStore(project.root);
  const token = `pjob_${"A".repeat(43)}`;
  try {
    const allocated = await store.allocate(token, "hostile");
    await writeFile(join(allocated.path, "part.bin"), "prefix addons/godot_mcp/runtime suffix");
    await expect(store.finalize(token, "hostile")).rejects.toThrow(/MCP components/i);
    await rm(allocated.path, { recursive: true, force: true });
    const second = await store.allocate(token, "hostile");
    await symlink(join(project.root, "project.godot"), join(second.path, "escape"));
    await expect(store.finalize(token, "hostile")).rejects.toThrow(/symbolic link/i);
  } finally { await project.cleanup(); }
});
