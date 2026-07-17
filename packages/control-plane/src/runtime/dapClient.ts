import { connect, type Socket } from "node:net";

import { DapFrameParser, DapProtocolError, encodeDapMessage } from "./dapFraming.js";

const ALLOWED_DAP_COMMANDS = [
  "initialize", "attach", "disconnect", "setBreakpoints", "threads", "stackTrace",
  "scopes", "variables", "pause", "continue", "next", "stepIn",
] as const;

export type DapCommand = (typeof ALLOWED_DAP_COMMANDS)[number];
type DapClientErrorCode = "INVALID_REQUEST" | "TIMEOUT" | "TRANSPORT_ERROR";

export class DapClientError extends Error {
  constructor(readonly code: DapClientErrorCode, message: string) {
    super(message);
    this.name = "DapClientError";
  }
}

export interface DapStopEvent {
  sequence: number;
  reason: string;
  body: Record<string, unknown>;
}

interface PendingRequest {
  command: DapCommand;
  resolve(value: Record<string, unknown>): void;
  reject(error: DapClientError): void;
  timer: NodeJS.Timeout;
}

interface StopWaiter {
  afterSequence: number;
  resolve(value: DapStopEvent): void;
  reject(error: DapClientError): void;
  timer: NodeJS.Timeout;
}

export class DapClient {
  private readonly parser = new DapFrameParser();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly stopEvents: DapStopEvent[] = [];
  private readonly stopWaiters = new Set<StopWaiter>();
  private requestTail: Promise<void> = Promise.resolve();
  private nextRequestSequence = 1;
  private stopSequence = 0;
  private connected = true;
  private stopped = false;
  private terminalError: DapClientError | null = null;

  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (error) => this.failClosed(new DapClientError("TRANSPORT_ERROR", `Godot DAP transport failed: ${error.message}`)));
    socket.on("close", () => {
      if (this.connected) this.failClosed(new DapClientError("TRANSPORT_ERROR", "Godot DAP transport closed"));
    });
  }

  static async connect(input: { host: string; port: number; connectTimeoutMs?: number }): Promise<DapClient> {
    if (input.host !== "127.0.0.1") throw new DapClientError("INVALID_REQUEST", "Godot DAP must use IPv4 loopback");
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
      throw new DapClientError("INVALID_REQUEST", "Godot DAP port is invalid");
    }
    const timeoutMs = Math.min(Math.max(input.connectTimeoutMs ?? 5_000, 1), 10_000);
    const socket = connect({ host: input.host, port: input.port });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new DapClientError("TIMEOUT", "Godot DAP connection timed out"));
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(new DapClientError("TRANSPORT_ERROR", `Godot DAP connection failed: ${error.message}`));
      });
    });
    socket.setNoDelay(true);
    return new DapClient(socket);
  }

  request(command: DapCommand, argumentsValue: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    if (!(ALLOWED_DAP_COMMANDS as readonly string[]).includes(command)) {
      return Promise.reject(new DapClientError("INVALID_REQUEST", `DAP command ${String(command)} is not allowed`));
    }
    const run = this.requestTail.then(() => this.executeRequest(command, argumentsValue, timeoutMs));
    this.requestTail = run.then(() => undefined, () => undefined);
    return run;
  }

  nextStop(afterSequence: number, timeoutMs: number): Promise<DapStopEvent> {
    if (!Number.isInteger(afterSequence) || afterSequence < 0 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      return Promise.reject(new DapClientError("INVALID_REQUEST", "DAP stop wait bounds are invalid"));
    }
    if (this.terminalError) return Promise.reject(this.terminalError);
    const availableIndex = this.stopEvents.findIndex((event) => event.sequence > afterSequence);
    if (availableIndex >= 0) {
      const available = this.stopEvents[availableIndex]!;
      this.stopEvents.splice(0, availableIndex + 1);
      return Promise.resolve({ ...available, body: { ...available.body } });
    }
    return new Promise<DapStopEvent>((resolve, reject) => {
      const waiter: StopWaiter = {
        afterSequence,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.stopWaiters.delete(waiter);
          reject(new DapClientError("TIMEOUT", "Timed out waiting for Godot debugger to stop"));
        }, timeoutMs),
      };
      this.stopWaiters.add(waiter);
    });
  }

  snapshot(): { connected: boolean; stopped: boolean; stopSequence: number } {
    return { connected: this.connected, stopped: this.stopped, stopSequence: this.stopSequence };
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    this.rejectAll(new DapClientError("TRANSPORT_ERROR", "Godot DAP client closed"));
    this.socket.destroy();
  }

  private executeRequest(command: DapCommand, argumentsValue: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (!this.connected) return Promise.reject(new DapClientError("TRANSPORT_ERROR", "Godot DAP client is disconnected"));
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
      return Promise.reject(new DapClientError("INVALID_REQUEST", "DAP request timeout is outside 1..10000 ms"));
    }
    const sequence = this.nextRequestSequence++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const pending: PendingRequest = {
        command,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pending.delete(sequence);
          const error = new DapClientError("TIMEOUT", `Godot DAP ${command} request timed out`);
          reject(error);
          this.failClosed(error);
        }, timeoutMs),
      };
      this.pending.set(sequence, pending);
      try {
        this.socket.write(encodeDapMessage({ seq: sequence, type: "request", command, arguments: argumentsValue }));
      } catch (error) {
        clearTimeout(pending.timer);
        this.pending.delete(sequence);
        const transportError = new DapClientError("TRANSPORT_ERROR", `Failed to encode Godot DAP request: ${error instanceof Error ? error.message : String(error)}`);
        reject(transportError);
        this.failClosed(transportError);
      }
    });
  }

  private onData(chunk: Buffer): void {
    if (!this.connected) return;
    try {
      for (const message of this.parser.push(chunk)) this.onMessage(message);
    } catch (error) {
      const message = error instanceof DapProtocolError ? error.message : String(error);
      this.failClosed(new DapClientError("TRANSPORT_ERROR", `Godot DAP protocol violation: ${message}`));
    }
  }

  private onMessage(message: Record<string, unknown>): void {
    if (message.type === "response") {
      const requestSequence = message.request_seq;
      if (!Number.isInteger(requestSequence)) throw new DapProtocolError("DAP response omitted request_seq");
      const pending = this.pending.get(Number(requestSequence));
      if (!pending) throw new DapProtocolError("DAP response referenced an unknown request");
      if (message.command !== pending.command || typeof message.success !== "boolean") {
        throw new DapProtocolError("DAP response identity does not match its request");
      }
      clearTimeout(pending.timer);
      this.pending.delete(Number(requestSequence));
      if (!message.success) pending.reject(new DapClientError("TRANSPORT_ERROR", boundedMessage(message.message, `Godot DAP ${pending.command} failed`)));
      else pending.resolve(message);
      return;
    }
    if (message.type !== "event" || typeof message.event !== "string") throw new DapProtocolError("DAP message type is unsupported");
    const body = isRecord(message.body) ? message.body : {};
    if (message.event === "stopped") {
      this.stopped = true;
      const event: DapStopEvent = { sequence: ++this.stopSequence, reason: boundedMessage(body.reason, "unknown"), body: { ...body } };
      let delivered = false;
      for (const waiter of [...this.stopWaiters]) {
        if (event.sequence <= waiter.afterSequence) continue;
        clearTimeout(waiter.timer);
        this.stopWaiters.delete(waiter);
        waiter.resolve({ ...event, body: { ...event.body } });
        delivered = true;
      }
      if (!delivered) {
        this.stopEvents.push(event);
        if (this.stopEvents.length > 512) this.stopEvents.shift();
      }
      return;
    }
    if (message.event === "continued") {
      this.stopped = false;
      return;
    }
    if (message.event === "terminated" || message.event === "exited") {
      this.failClosed(new DapClientError("TRANSPORT_ERROR", `Godot DAP reported ${message.event}`));
    }
  }

  private failClosed(error: DapClientError): void {
    if (this.terminalError) return;
    this.terminalError = error;
    this.connected = false;
    this.rejectAll(error);
    this.socket.destroy();
  }

  private rejectAll(error: DapClientError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.stopWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.stopWaiters.clear();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedMessage(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  return value.slice(0, 512);
}
