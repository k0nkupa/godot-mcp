import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import {
  BridgeEnvelopeSchema,
  canonicalFloat64Le,
  canonicalJson,
  decodeFloat64Le,
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

const FLOAT_WIRE_KEY = "$godotMcpFloat64Le";

function isFloatWireShape(value: unknown): value is Record<typeof FLOAT_WIRE_KEY, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 1 && FLOAT_WIRE_KEY in value;
}

function isFloatWireValue(value: unknown): value is Record<typeof FLOAT_WIRE_KEY, string> {
  return isFloatWireShape(value) && typeof value[FLOAT_WIRE_KEY] === "string" &&
    /^[a-f0-9]{16}$/.test(value[FLOAT_WIRE_KEY]);
}

function encodeFloatParams(value: unknown, allowWireValues = false): unknown {
  if (typeof value === "number") {
    if (Number.isFinite(value) && !Number.isSafeInteger(value)) {
      return { [FLOAT_WIRE_KEY]: canonicalFloat64Le(value) };
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => encodeFloatParams(entry, allowWireValues));
  if (value !== null && typeof value === "object") {
    if (isFloatWireShape(value)) {
      if (!allowWireValues) throw new TypeError("Bridge parameters contain a reserved float wire value");
      if (!isFloatWireValue(value)) throw new TypeError("Bridge parameters contain a malformed float wire value");
      return value;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, encodeFloatParams(entry, allowWireValues)]),
    );
  }
  return value;
}

function decodeFloatParams(value: unknown): unknown {
  if (isFloatWireValue(value)) return decodeFloat64Le(value[FLOAT_WIRE_KEY]);
  if (Array.isArray(value)) return value.map(decodeFloatParams);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decodeFloatParams(entry)]));
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

function signingText(envelope: UnsignedBridgeEnvelope, allowWireValues: boolean): string {
  return [
    envelope.sessionId,
    String(envelope.sequence),
    String(envelope.deadlineUnixMs),
    envelope.method,
    canonicalJson(encodeFloatParams(envelope.params, allowWireValues)),
  ].join("\n");
}

export function envelopeSigningText(envelope: UnsignedBridgeEnvelope): string {
  return signingText(envelope, false);
}

export function signEnvelope(key: Uint8Array, envelope: UnsignedBridgeEnvelope): BridgeEnvelope {
  const wireEnvelope = { ...envelope, params: encodeFloatParams(envelope.params) };
  const mac = createHmac("sha256", key).update(signingText(wireEnvelope, true), "utf8").digest("hex");
  return BridgeEnvelopeSchema.parse({ ...wireEnvelope, mac });
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
    .update(signingText(envelope, true), "utf8")
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
  return BridgeEnvelopeSchema.parse({ ...envelope, params: decodeFloatParams(envelope.params) });
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
