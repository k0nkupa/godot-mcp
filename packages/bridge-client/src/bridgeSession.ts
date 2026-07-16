import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import {
  GodotMcpException,
  signEnvelope,
  type EnvelopeVerifier,
  type SessionGrants,
} from "@godot-mcp/control-plane";
import {
  BridgeCommandChunkSchema,
  BridgeCommandResultSchema,
  type BridgeEnvelope,
  type GodotMcpError,
  type ProjectIdentity,
} from "@godot-mcp/protocol";
import { WebSocket, type RawData } from "ws";

export interface BridgeSessionInfo {
  sessionId: string;
  project: ProjectIdentity;
  grants: SessionGrants;
  godotVersion: string;
  addonManifestSha256: string;
}

export interface BridgeRequestOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  correlationId?: string;
}

export interface BridgeCommandResult<T> {
  requestId: string;
  data: T;
  binary?: Uint8Array;
  binarySha256?: string;
}

interface PendingRequest {
  resolve(value: BridgeCommandResult<unknown>): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
  maxResponseBytes: number;
  chunks: Uint8Array[];
  nextChunkIndex: number;
  totalChunks?: number;
  binarySha256?: string;
  receivedBytes: number;
}

const MAX_PENDING_REQUESTS = 16;
const MAX_CHUNK_BYTES = 512 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;

function bridgeError(
  code: GodotMcpError["code"],
  message: string,
  retryable = false,
  correlationId: string = randomUUID(),
): GodotMcpException {
  return new GodotMcpException({
    code,
    message,
    retryable,
    correlationId,
    partialEffects: false,
    rollback: "not_needed",
  });
}

export class BridgeSession {
  private readonly events = new EventEmitter();
  private readonly pending = new Map<string, PendingRequest>();
  private sendSequence = 0;

  constructor(
    private readonly socket: WebSocket,
    private readonly key: Uint8Array,
    private readonly verifier: EnvelopeVerifier,
    readonly info: BridgeSessionInfo,
  ) {
    socket.on("message", this.handleMessage);
    socket.once("close", () => {
      this.rejectAllPending("NOT_ATTACHED", "Bridge session disconnected");
      this.events.emit("close");
    });
  }

  get sessionId(): string {
    return this.info.sessionId;
  }

  onEnvelope(listener: (envelope: BridgeEnvelope) => void): () => void {
    this.events.on("envelope", listener);
    return () => this.events.off("envelope", listener);
  }

  onClose(listener: () => void): () => void {
    this.events.on("close", listener);
    return () => this.events.off("close", listener);
  }

  onRejected(listener: (code: "AUTHENTICATION_FAILED" | "INVALID_REQUEST") => void): () => void {
    this.events.on("rejected", listener);
    return () => this.events.off("rejected", listener);
  }

  send(method: string, params: unknown, deadlineUnixMs = Date.now() + 30_000): BridgeEnvelope {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error("Bridge session is closed");
    this.sendSequence += 1;
    const envelope = signEnvelope(this.key, {
      sessionId: this.sessionId,
      sequence: this.sendSequence,
      deadlineUnixMs,
      method,
      params,
    });
    this.socket.send(JSON.stringify(envelope));
    return envelope;
  }

  request<T>(
    method:
      | "editor.query"
      | "editor.capture"
      | "editor.mutate"
      | "runtime.prepare"
      | "runtime.command"
      | "runtime.capture"
      | "runtime.cleanup",
    params: unknown,
    options: BridgeRequestOptions = {},
  ): Promise<BridgeCommandResult<T>> {
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(bridgeError("CONFLICT", "Bridge request queue is full"));
    }
    const requestId = options.correlationId ?? randomUUID();
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 30_000, 1), 60_000);
    const maxResponseBytes = Math.min(
      Math.max(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, 1),
      8 * 1024 * 1024,
    );
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          bridgeError(
            "TIMEOUT",
            `Bridge request timed out after ${timeoutMs}ms`,
            true,
            requestId,
          ),
        );
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: resolve as PendingRequest["resolve"],
        reject,
        timeout,
        maxResponseBytes,
        chunks: [],
        nextChunkIndex: 0,
        receivedBytes: 0,
      });
      try {
        this.send(method, { requestId, arguments: params }, Date.now() + timeoutMs);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(code = 1001, reason = "server closing"): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolvePromise) => {
      const timeout = setTimeout(() => this.socket.terminate(), 1_000);
      this.socket.once("close", () => {
        clearTimeout(timeout);
        resolvePromise();
      });
      this.socket.close(code, reason);
    });
  }

  private readonly handleMessage = (data: RawData, isBinary: boolean): void => {
    if (isBinary) {
      this.events.emit("rejected", "INVALID_REQUEST");
      this.socket.close(1008, "binary frames are not allowed");
      return;
    }
    try {
      const envelope = this.verifier.verify(JSON.parse(data.toString()) as unknown);
      if (envelope.sessionId !== this.sessionId) throw new Error("Session ID mismatch");
      if (envelope.method === "command.chunk") {
        this.handleCommandChunk(envelope.params);
        return;
      }
      if (envelope.method === "command.result") {
        this.handleCommandResult(envelope.params);
        return;
      }
      this.events.emit("envelope", envelope);
    } catch {
      this.events.emit("rejected", "AUTHENTICATION_FAILED");
      this.socket.close(1008, "invalid signed envelope");
    }
  };

  private handleCommandChunk(input: unknown): void {
    let parsed;
    try {
      parsed = BridgeCommandChunkSchema.parse(input);
    } catch {
      const requestId =
        typeof input === "object" && input !== null && "requestId" in input
          ? String(input.requestId)
          : undefined;
      if (requestId) this.rejectPending(requestId, "INVALID_REQUEST", "Malformed command chunk");
      else this.socket.close(1008, "malformed command chunk");
      return;
    }
    const pending = this.pending.get(parsed.requestId);
    if (!pending) return;
    const bytes = Buffer.from(parsed.data, "base64url");
    if (
      parsed.index !== pending.nextChunkIndex ||
      bytes.length > MAX_CHUNK_BYTES ||
      (pending.totalChunks !== undefined && pending.totalChunks !== parsed.total) ||
      (pending.binarySha256 !== undefined && pending.binarySha256 !== parsed.sha256) ||
      pending.receivedBytes + bytes.length > pending.maxResponseBytes
    ) {
      this.rejectPending(parsed.requestId, "INVALID_REQUEST", "Invalid command chunk stream");
      return;
    }
    pending.totalChunks = parsed.total;
    pending.binarySha256 = parsed.sha256;
    pending.chunks.push(bytes);
    pending.receivedBytes += bytes.length;
    pending.nextChunkIndex += 1;
  }

  private handleCommandResult(input: unknown): void {
    let parsed;
    try {
      parsed = BridgeCommandResultSchema.parse(input);
    } catch {
      const requestId =
        typeof input === "object" && input !== null && "requestId" in input
          ? String(input.requestId)
          : undefined;
      if (requestId) this.rejectPending(requestId, "INVALID_REQUEST", "Malformed command result");
      else this.socket.close(1008, "malformed command result");
      return;
    }
    const pending = this.pending.get(parsed.requestId);
    if (!pending) return;
    if (!parsed.ok) {
      const error = parsed.error;
      this.finishPending(
        parsed.requestId,
        undefined,
        bridgeError(
          error?.code ?? "GODOT_RUNTIME_ERROR",
          error?.message ?? "Godot command failed",
          error?.retryable ?? false,
          parsed.requestId,
        ),
      );
      return;
    }

    let binary: Uint8Array | undefined;
    if (parsed.binary) {
      binary = Buffer.concat(pending.chunks);
      const digest = createHash("sha256").update(binary).digest("hex");
      if (
        pending.nextChunkIndex !== parsed.binary.chunks ||
        pending.totalChunks !== parsed.binary.chunks ||
        pending.binarySha256 !== parsed.binary.sha256 ||
        binary.length !== parsed.binary.size ||
        digest !== parsed.binary.sha256
      ) {
        this.rejectPending(parsed.requestId, "INVALID_REQUEST", "Command binary verification failed");
        return;
      }
    } else if (pending.chunks.length > 0) {
      this.rejectPending(parsed.requestId, "INVALID_REQUEST", "Command result omitted binary metadata");
      return;
    }

    const value: BridgeCommandResult<unknown> = {
      requestId: parsed.requestId,
      data: parsed.data,
    };
    if (binary !== undefined && parsed.binary !== undefined) {
      value.binary = binary;
      value.binarySha256 = parsed.binary.sha256;
    }
    this.finishPending(parsed.requestId, value);
  }

  private rejectPending(
    requestId: string,
    code: GodotMcpError["code"],
    message: string,
  ): void {
    this.finishPending(requestId, undefined, bridgeError(code, message, false, requestId));
  }

  private finishPending(
    requestId: string,
    value?: BridgeCommandResult<unknown>,
    error?: Error,
  ): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    pending.chunks.length = 0;
    if (error) pending.reject(error);
    else if (value) pending.resolve(value);
  }

  private rejectAllPending(code: GodotMcpError["code"], message: string): void {
    for (const requestId of [...this.pending.keys()]) {
      this.rejectPending(requestId, code, message);
    }
  }
}
