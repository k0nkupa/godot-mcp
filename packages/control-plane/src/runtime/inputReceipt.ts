import { createHash } from "node:crypto";

import {
  canonicalJson,
  type InputEvent,
  type InputOperationInput,
  type InputTrace,
  type InputTraceEvent,
  type RuntimeHandle,
} from "@godot-mcp/protocol";

export interface InputAuditSummary {
  handle: RuntimeHandle;
  operation: InputOperationInput["operation"];
  mode?: "realtime" | "deterministic";
  eventCount: number;
  eventKinds: Partial<Record<InputEvent["type"], number>>;
  firstFrameOffset: number | null;
  lastFrameOffset: number | null;
  traceSha256: string;
}

export function inputTraceEvents(input: InputOperationInput): InputTraceEvent[] {
  switch (input.operation) {
    case "send":
      return [{ frameOffset: 0, event: input.event }];
    case "sequence":
      return input.events;
    case "replay":
      return input.trace.events;
    case "record_start":
    case "record_stop":
      return [];
  }
}

export function traceSha256(trace: InputTrace): string {
  return createHash("sha256").update(canonicalJson(trace)).digest("hex");
}

export function summarizeInputForAudit(input: InputOperationInput): InputAuditSummary {
  const events = inputTraceEvents(input);
  const eventKinds: InputAuditSummary["eventKinds"] = {};
  for (const { event } of events) eventKinds[event.type] = (eventKinds[event.type] ?? 0) + 1;
  const mode = input.operation === "sequence" || input.operation === "replay" ? input.mode : undefined;
  return {
    handle: input.handle,
    operation: input.operation,
    ...(mode === undefined ? {} : { mode }),
    eventCount: events.length,
    eventKinds,
    firstFrameOffset: events[0]?.frameOffset ?? null,
    lastFrameOffset: events.at(-1)?.frameOffset ?? null,
    traceSha256: traceSha256({ schemaVersion: 1, events }),
  };
}
