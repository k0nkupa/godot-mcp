#!/usr/bin/env node

import { parseArgs } from "node:util";
import { resolve } from "node:path";

import {
  connectProject,
  disableAddon,
  doctorProject,
  initProject,
  uninstallProject,
} from "./index.js";
import { parseConnectGrants } from "./commands/connect.js";

async function main(): Promise<number> {
  const parsed = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: "string", short: "p", default: process.cwd() },
      source: { type: "string", default: resolve(process.cwd(), "addons/godot_mcp") },
      godot: { type: "string" },
      grant: { type: "string", multiple: true, default: [] },
      pack: { type: "string", multiple: true, default: [] },
    },
  });
  const [command, ...extra] = parsed.positionals;
  if (!command || extra.length > 0 || !["init", "doctor", "disable", "uninstall", "connect"].includes(command)) {
    process.stderr.write("Usage: godot-mcp <init|doctor|disable|uninstall|connect> [--project PATH]\n");
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
  if (command === "connect") {
    await connectProject(
      parsed.values.project,
      parseConnectGrants(parsed.values.grant, parsed.values.pack),
      parsed.values.godot,
    );
    return 0;
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
