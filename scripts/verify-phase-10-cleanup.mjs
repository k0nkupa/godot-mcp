import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const unsafeRoot = resolve(root, "fixtures/godot-4.7/.godot/evidence/godot-mcp/unsafe");
const entries = await readdir(unsafeRoot).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
if (entries.length > 0) throw new Error(`Phase 10 unsafe fixture residue remains: ${entries.join(", ")}`);
process.stdout.write("[phase-10] unsafe source/process residue cleanup verified\n");
