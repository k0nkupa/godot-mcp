#!/usr/bin/env node

import { parseArgs } from "node:util";
import { resolve } from "node:path";

import { disableAddon, doctorProject, initProject, uninstallProject } from "./index.js";

async function main(): Promise<number> {
  const parsed = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: "string", short: "p", default: process.cwd() },
      source: { type: "string", default: resolve(process.cwd(), "addons/godot_mcp") },
      godot: { type: "string" },
    },
  });
  const [command, ...extra] = parsed.positionals;
  if (!command || extra.length > 0 || !["init", "doctor", "disable", "uninstall"].includes(command)) {
    process.stderr.write("Usage: godot-mcp <init|doctor|disable|uninstall> [--project PATH]\n");
    return 2;
  }

  if (command === "init") {
    const report = await initProject(parsed.values.project, parsed.values.source, parsed.values.godot);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report.healthy ? 0 : 4;
  }
  if (command === "doctor") {
    const report = await doctorProject(parsed.values.project);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report.healthy ? 0 : 4;
  }
  if (command === "disable") {
    await disableAddon(parsed.values.project, parsed.values.godot);
  } else {
    await uninstallProject(parsed.values.project);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, command })}\n`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  const code = (error as { code?: string }).code;
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = code === "CONFLICT" ? 3 : 4;
}
