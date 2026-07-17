import { describe, expect, it } from "vitest";

import {
  BridgeEnvelopeSchema,
  CapabilityPackSchema,
  PermissionTierSchema,
  ProjectIdentitySchema,
  GodotMcpErrorSchema,
} from "./index.js";

describe("protocol schemas", () => {
  it("accepts the defined permission tiers and rejects unknown tiers", () => {
    expect(PermissionTierSchema.safeParse("observe").success).toBe(true);
    expect(PermissionTierSchema.safeParse("unsafe_fixture").success).toBe(true);
    expect(PermissionTierSchema.safeParse("admin").success).toBe(false);
  });

  it("accepts the defined capability packs and rejects unknown packs", () => {
    expect(CapabilityPackSchema.safeParse("core").success).toBe(true);
    expect(CapabilityPackSchema.safeParse("unsafe").success).toBe(true);
    expect(CapabilityPackSchema.safeParse("shell").success).toBe(false);
  });

  it("requires signed envelopes after pairing", () => {
    expect(BridgeEnvelopeSchema.safeParse({ sessionId: "s", sequence: 1 }).success).toBe(false);
  });

  it("validates project identity hashes and UUIDs", () => {
    const identity = {
      projectId: "019f644c-1379-79c0-825e-66a4b7653bd1",
      rootRealPath: "/tmp/project",
      projectConfigSha256: "a".repeat(64),
      godotVersion: "4.7.stable",
    };

    expect(ProjectIdentitySchema.safeParse(identity).success).toBe(true);
    expect(ProjectIdentitySchema.safeParse({ ...identity, projectConfigSha256: "nope" }).success).toBe(false);
  });

  it("normalizes recovery metadata on stable errors", () => {
    expect(GodotMcpErrorSchema.parse({
      code: "CONFLICT",
      message: "changed",
      retryable: false,
      correlationId: "req-1",
      partialEffects: false,
      rollback: "not_needed",
    })).toMatchObject({ failedPhase: "request", safeRecovery: "Review the error and retry only after correcting the request" });
  });

  it("represents fail-closed debugger transport errors", () => {
    expect(GodotMcpErrorSchema.parse({
      code: "TRANSPORT_ERROR",
      message: "Godot DAP disconnected",
      retryable: true,
      correlationId: "req-dap",
      partialEffects: false,
      rollback: "not_needed",
    })).toMatchObject({ code: "TRANSPORT_ERROR" });
  });
});
