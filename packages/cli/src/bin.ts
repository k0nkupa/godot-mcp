#!/usr/bin/env node

import { parseArgs } from "node:util";
import { resolve } from "node:path";

import {
  connectProject,
  approveUnsafeFixtureCommand,
  defaultUnsafeRegistryPath,
  disableAddon,
  doctorProject,
  initProject,
  launchSecureEditor,
  registerUnsafeFixtureCommand,
  stampUnsafeFixtureCopyCommand,
  uninstallProject,
  upgradeProject,
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
      registry: { type: "string", default: defaultUnsafeRegistryPath() },
      activation: { type: "string" },
      "activation-dir": { type: "string" },
      confirmation: { type: "string" },
      registration: { type: "string" },
      "ttl-ms": { type: "string" },
      extension: { type: "string", multiple: true, default: [] },
    },
  });
  const [command, ...extra] = parsed.positionals;
  if (!command || extra.length > 0 || !["init", "upgrade", "doctor", "disable", "uninstall", "connect", "editor", "unsafe-register", "unsafe-stamp-copy", "unsafe-approve"].includes(command)) {
    process.stderr.write("Usage: godot-mcp <init|upgrade|doctor|disable|uninstall|connect|editor|unsafe-register|unsafe-stamp-copy|unsafe-approve> [--project PATH]\n");
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
  if (command === "upgrade") {
    await upgradeProject(parsed.values.project, parsed.values.source);
    process.stdout.write(`${JSON.stringify({ ok: true, command })}\n`);
    return 0;
  }
  if (command === "editor") {
    return launchSecureEditor(parsed.values.project, parsed.values.godot);
  }
  if (command === "connect") {
    await connectProject(
      parsed.values.project,
      parseConnectGrants(parsed.values.grant, parsed.values.pack),
      parsed.values.godot,
      parsed.values.activation === undefined ? undefined : { registryPath: parsed.values.registry, leasePath: parsed.values.activation },
      parsed.values.extension,
    );
    return 0;
  }
  if (command === "unsafe-register") {
    const result = await registerUnsafeFixtureCommand(parsed.values.project, parsed.values.registry, parsed.values.confirmation ?? "");
    process.stdout.write(`${JSON.stringify(result)}\n`); return 0;
  }
  if (command === "unsafe-stamp-copy") {
    if (!parsed.values.registration) throw new Error("--registration is required");
    const result = await stampUnsafeFixtureCopyCommand(parsed.values.project, parsed.values.registry, parsed.values.registration);
    process.stdout.write(`${JSON.stringify(result)}\n`); return 0;
  }
  if (command === "unsafe-approve") {
    if (!parsed.values["activation-dir"]) throw new Error("--activation-dir is required");
    const ttlMs = parsed.values["ttl-ms"] === undefined ? undefined : Number(parsed.values["ttl-ms"]);
    const result = await approveUnsafeFixtureCommand(parsed.values.project, parsed.values.registry, parsed.values["activation-dir"], parsed.values.confirmation ?? "", ttlMs);
    process.stdout.write(`${JSON.stringify(result)}\n`); return 0;
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
