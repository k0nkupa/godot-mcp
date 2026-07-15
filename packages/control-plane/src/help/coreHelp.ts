import { randomUUID } from "node:crypto";

import { GodotMcpException } from "../errors.js";

export type CoreHelpTopic = "session" | "capabilities" | "doctor" | "help" | "query" | "capture";

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
    summary: "Returns focused documentation for one of the read-only core tools.",
    tool: "godot_help",
    readOnly: true,
  },
  query: {
    topic: "query",
    title: "Query Godot editor",
    summary: "Reads bounded editor state, open scene trees and nodes, indexed resource metadata, approved project settings, or redacted diagnostics.",
    tool: "godot_query",
    readOnly: true,
  },
  capture: {
    topic: "capture",
    title: "Capture Godot editor viewport",
    summary: "Returns a bounded PNG image from the current 2D editor viewport or one of four 3D editor viewports without switching editor screens.",
    tool: "godot_capture",
    readOnly: true,
  },
};

export function getCoreHelp(topic: CoreHelpTopic = "help"): CoreHelp {
  const help = HELP[topic];
  if (!help) {
    throw new GodotMcpException({
      code: "TARGET_NOT_FOUND",
      message: `Unknown core help topic: ${String(topic)}`,
      retryable: false,
      correlationId: randomUUID(),
      partialEffects: false,
      rollback: "not_needed",
    });
  }
  return { ...help };
}
