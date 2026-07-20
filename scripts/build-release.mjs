import { resolve } from "node:path";
import { buildRelease } from "./release-contract.mjs";

const output = resolve(process.argv[2] ?? "release/out");
const manifest = await buildRelease({ root: resolve(import.meta.dirname, ".."), output });
process.stdout.write(`${JSON.stringify({ output, version: manifest.version, artifacts: manifest.artifacts.length })}\n`);
