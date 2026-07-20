import { access, readFile } from "node:fs/promises";

const path = process.argv[2];
if (!path) throw new Error("Phase 9 cleanup record path is required");
const record = JSON.parse(await readFile(path, "utf8"));
if (record.removed !== true || record.clean !== true) throw new Error("Phase 9 fixture did not record clean completion");
try { await access(record.container); throw new Error("Phase 9 disposable fixture still exists"); }
catch (error) { if (error.code !== "ENOENT") throw error; }
process.stdout.write("[phase-9] cleanup verified\n");
