import { randomUUID } from "node:crypto";

import { GodotMcpException } from "../errors.js";

export type CoreHelpTopic = "session" | "capabilities" | "doctor" | "help";

export interface CoreHelp {
  topic: CoreHelpTopic;
  title: string;
  summary: string;
  tool: `godot_${CoreHelpTopic}`;
  readOnly: true;
}

const HELP: Record<CoreHelpTopic, CoreHelp> = {
  session: {
    topic: "session",
    title: "Godot session status",
    summary: "Returns attachment state, project identity, versions, and granted access without credentials.",
    tool: "godot_session",
    readOnly: true,
  },
  capabilities: {
    topic: "capabilities",
    title: "Godot capabilities",
    summary: "Lists only operations authorized by the current permission tiers and capability packs.",
    tool: "godot_capabilities",
    readOnly: true,
  },
  doctor: {
    topic: "doctor",
    title: "Godot MCP doctor",
    summary: "Combines read-only installation checks with current bridge attachment health.",
    tool: "godot_doctor",
    readOnly: true,
  },
  help: {
    topic: "help",
    title: "Godot MCP help",
    summary: "Returns focused documentation for one of the four Phase 1 read-only tools.",
    tool: "godot_help",
    readOnly: true,
  },
};

export function getCoreHelp(topic: CoreHelpTopic = "help"): CoreHelp {
  const help = HELP[topic];
  if (!help) {
    throw new GodotMcpException({
      code: "TARGET_NOT_FOUND",
      message: `Unknown Phase 1 help topic: ${String(topic)}`,
      retryable: false,
      correlationId: randomUUID(),
      partialEffects: false,
      rollback: "not_needed",
    });
  }
  return { ...help };
}
