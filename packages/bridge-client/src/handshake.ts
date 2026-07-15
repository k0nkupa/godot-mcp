import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";

import {
  EnvelopeVerifier,
  GodotMcpException,
  deriveSessionKey,
  type SessionDescriptor,
} from "@godot-mcp/control-plane";
import { BRIDGE_PROTOCOL_VERSION, PRODUCT_VERSION, canonicalJson } from "@godot-mcp/protocol";
import { WebSocket, type RawData } from "ws";

export interface PairRequest {
  method: "pair";
  token: string;
  sessionNonce: string;
  protocolVersion: string;
  productVersion: string;
  project: SessionDescriptor["project"];
  addonManifestSha256: string;
  godotVersion: string;
}

export interface HandshakeOptions {
  descriptor: SessionDescriptor;
  descriptorPath: string;
  addonManifestSha256: string;
  timeoutMs: number;
  now: () => number;
}

export interface HandshakeResult {
  sessionId: string;
  serverNonce: string;
  godotVersion: string;
  verifier: EnvelopeVerifier;
  key: Buffer;
}

function authenticationFailed(message: string): GodotMcpException {
  return new GodotMcpException({
    code: "AUTHENTICATION_FAILED",
    message,
    retryable: false,
    correlationId: randomUUID(),
    partialEffects: false,
    rollback: "not_needed",
  });
}

function sameSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function nextTextMessage(socket: WebSocket, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const onMessage = (data: RawData, isBinary: boolean): void => {
      cleanup();
      if (isBinary) reject(authenticationFailed("Binary handshake frames are not allowed"));
      else resolvePromise(data.toString());
    };
    const onClose = (): void => {
      cleanup();
      reject(authenticationFailed("Pairing connection closed before authentication"));
    };
    const onError = (): void => {
      cleanup();
      reject(authenticationFailed("Pairing transport failed"));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(authenticationFailed("Pairing handshake timed out"));
    }, timeoutMs);
    socket.on("message", onMessage);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

function parsePairRequest(text: string): PairRequest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw authenticationFailed("Pairing request is not valid JSON");
  }
  if (typeof value !== "object" || value === null) {
    throw authenticationFailed("Pairing request must be an object");
  }
  const request = value as Partial<PairRequest>;
  if (
    request.method !== "pair" ||
    typeof request.token !== "string" ||
    typeof request.sessionNonce !== "string" ||
    typeof request.protocolVersion !== "string" ||
    typeof request.productVersion !== "string" ||
    typeof request.project !== "object" ||
    request.project === null ||
    typeof request.addonManifestSha256 !== "string" ||
    typeof request.godotVersion !== "string"
  ) {
    throw authenticationFailed("The only allowed unauthenticated message is a complete pair request");
  }
  return request as PairRequest;
}

export async function performHandshake(
  socket: WebSocket,
  options: HandshakeOptions,
): Promise<HandshakeResult> {
  const request = parsePairRequest(await nextTextMessage(socket, options.timeoutMs));
  const descriptor = options.descriptor;
  if (descriptor.expiresAtUnixMs < options.now()) throw authenticationFailed("Pairing descriptor expired");
  if (!sameSecret(request.token, descriptor.token)) throw authenticationFailed("Pairing token is invalid");
  if (!sameSecret(request.sessionNonce, descriptor.sessionNonce)) {
    throw authenticationFailed("Pairing session nonce is invalid");
  }
  if (
    request.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
    request.productVersion !== PRODUCT_VERSION
  ) {
    throw authenticationFailed("Pairing protocol or product version does not match");
  }
  if (canonicalJson(request.project) !== canonicalJson(descriptor.project)) {
    throw authenticationFailed("Pairing project identity does not match");
  }
  if (request.addonManifestSha256 !== options.addonManifestSha256) {
    throw authenticationFailed("Pairing addon manifest does not match");
  }
  if (!request.godotVersion.startsWith("4.7.stable")) {
    throw authenticationFailed("Godot 4.7.stable is required");
  }

  await rm(options.descriptorPath, { force: true });
  const sessionId = `session_${randomUUID()}`;
  const serverNonce = randomBytes(32).toString("base64url");
  const serverProof = createHmac("sha256", Buffer.from(descriptor.token, "base64url"))
    .update(`godot-mcp:server-proof:v1\n${sessionId}\n${serverNonce}`)
    .digest("hex");
  const key = deriveSessionKey(descriptor.token, descriptor.sessionNonce, serverNonce);
  socket.send(
    JSON.stringify({
      method: "pair_ok",
      sessionId,
      serverNonce,
      grants: descriptor.grants,
      serverProof,
    }),
  );

  const verifier = new EnvelopeVerifier(key, { now: options.now });
  const acknowledgment = verifier.verify(
    JSON.parse(await nextTextMessage(socket, options.timeoutMs)) as unknown,
  );
  const params = acknowledgment.params as { serverProof?: unknown };
  if (
    acknowledgment.sessionId !== sessionId ||
    acknowledgment.method !== "pair.ack" ||
    typeof params !== "object" ||
    params === null ||
    typeof params.serverProof !== "string" ||
    !sameSecret(params.serverProof, serverProof)
  ) {
    throw authenticationFailed("Signed pairing acknowledgment is invalid");
  }
  return { sessionId, serverNonce, godotVersion: request.godotVersion, verifier, key };
}

export function rejectHandshake(socket: WebSocket, error: unknown): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(
      JSON.stringify({
        method: "pair_rejected",
        code: "AUTHENTICATION_FAILED",
        message: error instanceof Error ? error.message : "Pairing rejected",
      }),
      () => socket.close(1008, "authentication failed"),
    );
  }
}
