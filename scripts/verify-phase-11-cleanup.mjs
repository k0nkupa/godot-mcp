import { access, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const forbidden = ["release/out", "qa-failure-artifacts"];
for (const path of forbidden) {
  if (await access(resolve(root, path)).then(() => true, () => false)) throw new Error(`Phase 11 residue remains: ${path}`);
}
for (const entry of await readdir(resolve(root, "addons"))) {
  if (entry.startsWith(".godot_mcp.upgrade-") || entry.startsWith(".godot_mcp.rollback-")) throw new Error(`Phase 11 addon transaction residue remains: ${entry}`);
}
process.stdout.write("Phase 11 cleanup verified\n");
