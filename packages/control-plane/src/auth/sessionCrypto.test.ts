import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { canonicalFloat64Le, decodeFloat64Le } from "@godot-mcp/protocol";

import {
  EnvelopeVerifier,
  deriveSessionKey,
  envelopeSigningText,
  signEnvelope,
  verifyEnvelope,
  type UnsignedBridgeEnvelope,
} from "../index.js";

const token = Buffer.alloc(32, 7).toString("base64url");
const key = deriveSessionKey(token, "session-nonce", "server-nonce");

function envelope(overrides: Partial<UnsignedBridgeEnvelope> = {}): UnsignedBridgeEnvelope {
  return {
    sessionId: "session_1234567890",
    sequence: 1,
    deadlineUnixMs: 2_000,
    method: "session.status",
    params: { z: 1, a: true },
    ...overrides,
  };
}

describe("session crypto", () => {
  it("signs finite float parameters through explicit canonical tags", () => {
    const key = Buffer.alloc(32, 7);
    const signed = signEnvelope(key, envelope({ params: { roughness: 0.25, nested: [1.5, 2] } }));
    expect(verifyEnvelope(key, signed, { now: () => 1_000 }).params).toEqual({ roughness: 0.25, nested: [1.5, 2] });
    expect(signed.params).toEqual({ roughness: { $godotMcpFloat64Le: "000000000000d03f" }, nested: [{ $godotMcpFloat64Le: "000000000000f83f" }, 2] });
    expect(envelopeSigningText(envelope({ params: { progress: 0.000493333333333333 } }))).toContain(
      '"progress":{"$godotMcpFloat64Le":"8c4b2f44612a403f"}',
    );
    expect([
      canonicalFloat64Le(0.12345678901234567),
      canonicalFloat64Le(1e-300),
      canonicalFloat64Le(1.2345678901234567e+100),
    ]).toEqual(["5ef64637dd9abf3f", "59f3f8c21f6ea501", "83f19de8d893b654"]);
    for (const godotEncoded of ["704b2f44612a403f", "5ff64637dd9abf3f", "59f3f8c21f6ea501", "84f19de8d893b654"]) {
      expect(canonicalFloat64Le(decodeFloat64Le(godotEncoded))).toBe(godotEncoded);
    }
    const unsafeIntegralFloat = Number.MAX_SAFE_INTEGER + 1;
    expect(signEnvelope(key, envelope({ params: { value: unsafeIntegralFloat } })).params).toEqual({
      value: { $godotMcpFloat64Le: canonicalFloat64Le(unsafeIntegralFloat) },
    });
  });

  it("rejects a repeated signed sequence", () => {
    const verifier = new EnvelopeVerifier(key, { now: () => 1_000 });
    verifier.verify(signEnvelope(key, envelope({ sequence: 1, deadlineUnixMs: 2_000 })));
    expect(() =>
      verifier.verify(signEnvelope(key, envelope({ sequence: 1, deadlineUnixMs: 2_000 }))),
    ).toThrowError(expect.objectContaining({ code: "AUTHENTICATION_FAILED" }));
  });

  it("rejects caller dictionaries that collide with the reserved float wire shape", () => {
    expect(() => signEnvelope(key, envelope({ params: { value: { $godotMcpFloat64Le: "000000000000d03f" } } }))).toThrow(/reserved float wire/i);
    expect(() => signEnvelope(key, envelope({ params: { value: { $godotMcpFloat64Le: "NOT-A-WIRE-VALUE" } } }))).toThrow(/reserved float wire/i);
  });

  it("rejects tampering, expiry, and deadlines over 60 seconds away", () => {
    const signed = signEnvelope(key, envelope());
    expect(verifyEnvelope(key, signed, { now: () => 1_000 })).toEqual(signed);
    expect(() => verifyEnvelope(key, { ...signed, method: "other" }, { now: () => 1_000 })).toThrow();
    expect(() =>
      verifyEnvelope(key, signEnvelope(key, envelope({ deadlineUnixMs: 999 })), { now: () => 1_000 }),
    ).toThrow();
    expect(() =>
      verifyEnvelope(key, signEnvelope(key, envelope({ deadlineUnixMs: 61_001 })), { now: () => 1_000 }),
    ).toThrow();
  });

  it("matches the cross-language session crypto fixture", async () => {
    const fixture = JSON.parse(
      await readFile(new URL("../../../protocol/fixtures/session-crypto-v1.json", import.meta.url), "utf8"),
    ) as {
      token: string;
      sessionNonce: string;
      serverNonce: string;
      derivedKeyHex: string;
      envelope: UnsignedBridgeEnvelope;
      macHex: string;
    };
    const fixtureKey = deriveSessionKey(fixture.token, fixture.sessionNonce, fixture.serverNonce);
    expect(fixtureKey.toString("hex")).toBe(fixture.derivedKeyHex);
    expect(signEnvelope(fixtureKey, fixture.envelope).mac).toBe(fixture.macHex);
  });
});
