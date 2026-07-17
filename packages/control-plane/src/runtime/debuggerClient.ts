export const AUTHENTICATED_DEBUGGER_COMMANDS = [
  "disconnect",
  "setBreakpoints",
  "threads",
  "stackTrace",
  "scopes",
  "variables",
  "pause",
  "continue",
  "next",
  "stepIn",
] as const;

export type DebuggerCommand = (typeof AUTHENTICATED_DEBUGGER_COMMANDS)[number];
type DebuggerClientErrorCode = "INVALID_REQUEST" | "TIMEOUT" | "TRANSPORT_ERROR";

export class DebuggerClientError extends Error {
  constructor(readonly code: DebuggerClientErrorCode, message: string) {
    super(message);
    this.name = "DebuggerClientError";
  }
}

export interface DebuggerStopEvent {
  sequence: number;
  reason: string;
  body: Record<string, unknown>;
}
