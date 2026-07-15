import type { AddressInfo } from "node:net";
import { rm } from "node:fs/promises";

import {
  createPairingDescriptor,
  type AuditSink,
  type SessionGrants,
} from "@godot-mcp/control-plane";
import type { ProjectIdentity } from "@godot-mcp/protocol";
import { WebSocketServer, type WebSocket } from "ws";

import { BridgeSession } from "./bridgeSession.js";
import { performHandshake, rejectHandshake } from "./handshake.js";

export interface StartBridgeServerOptions {
  project: ProjectIdentity;
  grants: SessionGrants;
  addonManifestSha256: string;
  auditSink: AuditSink;
  handshakeTimeoutMs?: number;
  now?: () => number;
}

export interface BridgeServer {
  readonly port: number;
  readonly address: AddressInfo;
  readonly descriptorPath: string;
  readonly session: BridgeSession | null;
  waitForAttachment(timeoutMs: number): Promise<BridgeSession>;
  close(): Promise<void>;
}

export async function startBridgeServer(options: StartBridgeServerOptions): Promise<BridgeServer> {
  const websocket = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    path: "/bridge",
    maxPayload: 1_048_576,
    perMessageDeflate: false,
    clientTracking: true,
  });
  await new Promise<void>((resolvePromise, reject) => {
    websocket.once("listening", resolvePromise);
    websocket.once("error", reject);
  });
  const address = websocket.address() as AddressInfo;
  let pairing;
  try {
    pairing = await createPairingDescriptor(options.project, address.port, options.grants);
  } catch (error) {
    await new Promise<void>((resolvePromise) => websocket.close(() => resolvePromise()));
    throw error;
  }

  let currentSession: BridgeSession | null = null;
  let pendingSocket: WebSocket | null = null;
  let closePromise: Promise<void> | null = null;
  const attachmentWaiters = new Set<(session: BridgeSession) => void>();
  const now = options.now ?? Date.now;

  const audit = async (
    event: string,
    outcome: string,
    argumentsValue: unknown,
    errorCode: string | null,
  ): Promise<void> => {
    await options.auditSink.append({
      sessionId: currentSession?.sessionId ?? null,
      projectId: options.project.projectId,
      event,
      outcome,
      permissionTier: "observe",
      arguments: argumentsValue,
      errorCode,
    });
  };

  websocket.on("connection", (socket, request) => {
    socket.on("error", (error) => {
      if (/max payload size exceeded/i.test(error.message)) {
        void audit("transport.limit", "rejected", { limit: "maxPayload" }, "PAYLOAD_TOO_LARGE");
      }
    });
    if (
      request.socket.remoteAddress !== "127.0.0.1" ||
      pendingSocket !== null ||
      currentSession !== null ||
      closePromise !== null
    ) {
      socket.close(1008, "connection rejected");
      return;
    }
    pendingSocket = socket;
    void (async () => {
      try {
        const handshake = await performHandshake(socket, {
          descriptor: pairing.descriptor,
          descriptorPath: pairing.path,
          addonManifestSha256: options.addonManifestSha256,
          timeoutMs: options.handshakeTimeoutMs ?? 5_000,
          now,
        });
        const session = new BridgeSession(socket, handshake.key, handshake.verifier, {
          sessionId: handshake.sessionId,
          project: options.project,
          grants: options.grants,
          godotVersion: handshake.godotVersion,
          addonManifestSha256: options.addonManifestSha256,
        });
        currentSession = session;
        pendingSocket = null;
        session.onClose(() => {
          if (currentSession === session) currentSession = null;
          void audit("session.closed", "success", {}, null);
        });
        await audit("pair.succeeded", "success", { godotVersion: handshake.godotVersion }, null);
        for (const resolveWaiter of attachmentWaiters) resolveWaiter(session);
        attachmentWaiters.clear();
        session.send("pair.complete", { attached: true }, now() + 5_000);
      } catch (error) {
        pendingSocket = null;
        await audit("pair.rejected", "rejected", {}, "AUTHENTICATION_FAILED");
        rejectHandshake(socket, error);
      }
    })();
  });

  return {
    port: address.port,
    address,
    descriptorPath: pairing.path,
    get session(): BridgeSession | null {
      return currentSession;
    },
    waitForAttachment(timeoutMs: number): Promise<BridgeSession> {
      if (currentSession) return Promise.resolve(currentSession);
      return new Promise((resolvePromise, reject) => {
        const resolveAttachment = (session: BridgeSession): void => {
          clearTimeout(timeout);
          attachmentWaiters.delete(resolveAttachment);
          resolvePromise(session);
        };
        const timeout = setTimeout(() => {
          attachmentWaiters.delete(resolveAttachment);
          reject(new Error(`Godot addon did not attach within ${timeoutMs}ms`));
        }, timeoutMs);
        attachmentWaiters.add(resolveAttachment);
      });
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        await rm(pairing.path, { force: true });
        if (pendingSocket) {
          pendingSocket.terminate();
          pendingSocket = null;
        }
        if (currentSession) await currentSession.close();
        for (const client of websocket.clients) client.terminate();
        await new Promise<void>((resolvePromise) => websocket.close(() => resolvePromise()));
      })();
      return closePromise;
    },
  };
}
