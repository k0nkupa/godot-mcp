import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import {
  BridgeEnvelopeSchema,
  canonicalJson,
  type BridgeEnvelope,
} from "@godot-mcp/protocol";

import { GodotMcpException } from "../errors.js";

export type UnsignedBridgeEnvelope = Omit<BridgeEnvelope, "mac">;

export interface EnvelopeVerificationOptions {
  now?: () => number;
  maxFutureMs?: number;
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

function canonicalSigningParams(value: unknown): unknown {
  if (typeof value === "number") {
    if (Number.isFinite(value) && !Number.isInteger(value)) {
      return { type: "FloatJson", value: JSON.stringify(value) };
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalSigningParams);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, canonicalSigningParams(entry)]),
    );
  }
  return value;
}

export function deriveSessionKey(
  token: string,
  sessionNonce: string,
  serverNonce: string,
): Buffer {
  const tokenBytes = Buffer.from(token, "base64url");
  if (tokenBytes.length !== 32) throw authenticationFailed("Pairing token length is invalid");
  return createHmac("sha256", tokenBytes)
    .update(`godot-mcp:v1\n${sessionNonce}\n${serverNonce}`, "utf8")
    .digest();
}

export function envelopeSigningText(envelope: UnsignedBridgeEnvelope): string {
  return [
    envelope.sessionId,
    String(envelope.sequence),
    String(envelope.deadlineUnixMs),
    envelope.method,
    canonicalJson(canonicalSigningParams(envelope.params)),
  ].join("\n");
}

export function signEnvelope(key: Uint8Array, envelope: UnsignedBridgeEnvelope): BridgeEnvelope {
  const mac = createHmac("sha256", key).update(envelopeSigningText(envelope), "utf8").digest("hex");
  return BridgeEnvelopeSchema.parse({ ...envelope, mac });
}

export function verifyEnvelope(
  key: Uint8Array,
  input: unknown,
  options: EnvelopeVerificationOptions = {},
): BridgeEnvelope {
  let envelope: BridgeEnvelope;
  try {
    envelope = BridgeEnvelopeSchema.parse(input);
  } catch {
    throw authenticationFailed("Signed envelope is malformed");
  }
  const expected = createHmac("sha256", key)
    .update(envelopeSigningText(envelope), "utf8")
    .digest();
  const received = Buffer.from(envelope.mac, "hex");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw authenticationFailed("Signed envelope MAC is invalid");
  }

  const now = (options.now ?? Date.now)();
  const maxFutureMs = options.maxFutureMs ?? 60_000;
  if (envelope.deadlineUnixMs < now || envelope.deadlineUnixMs - now > maxFutureMs) {
    throw authenticationFailed("Signed envelope deadline is invalid");
  }
  return envelope;
}

export class EnvelopeVerifier {
  private lastSequence = 0;

  constructor(
    private readonly key: Uint8Array,
    private readonly options: EnvelopeVerificationOptions = {},
  ) {}

  verify(input: unknown): BridgeEnvelope {
    const envelope = verifyEnvelope(this.key, input, this.options);
    if (envelope.sequence <= this.lastSequence) {
      throw authenticationFailed("Signed envelope sequence was replayed or reordered");
    }
    this.lastSequence = envelope.sequence;
    return envelope;
  }
}
