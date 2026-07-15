import { EventEmitter } from "node:events";

import {
  signEnvelope,
  type EnvelopeVerifier,
  type SessionGrants,
} from "@godot-mcp/control-plane";
import type { BridgeEnvelope, ProjectIdentity } from "@godot-mcp/protocol";
import { WebSocket, type RawData } from "ws";

export interface BridgeSessionInfo {
  sessionId: string;
  project: ProjectIdentity;
  grants: SessionGrants;
  godotVersion: string;
  addonManifestSha256: string;
}

export class BridgeSession {
  private readonly events = new EventEmitter();
  private sendSequence = 0;

  constructor(
    private readonly socket: WebSocket,
    private readonly key: Uint8Array,
    private readonly verifier: EnvelopeVerifier,
    readonly info: BridgeSessionInfo,
  ) {
    socket.on("message", this.handleMessage);
    socket.once("close", () => this.events.emit("close"));
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
      this.events.emit("envelope", envelope);
    } catch {
      this.events.emit("rejected", "AUTHENTICATION_FAILED");
      this.socket.close(1008, "invalid signed envelope");
    }
  };
}
