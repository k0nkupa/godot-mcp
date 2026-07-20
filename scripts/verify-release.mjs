import { resolve } from "node:path";
import { verifyRelease } from "./release-contract.mjs";

const output = resolve(process.argv[2] ?? "release/out");
const manifest = await verifyRelease(output);
process.stdout.write(`${JSON.stringify({ verified: true, version: manifest.version, artifacts: manifest.artifacts.length })}\n`);
