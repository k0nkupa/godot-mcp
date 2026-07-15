import { describe, expect, it } from "vitest";

import { SessionService, type PublicAttachment, type SessionGrants } from "../index.js";

const project = {
  projectId: "019f644c-1379-79c0-825e-66a4b7653bd1",
  rootRealPath: "/tmp/godot-project",
  projectConfigSha256: "a".repeat(64),
};
const grants: SessionGrants = { tiers: ["observe"], packs: ["core"] };
const attached: PublicAttachment = {
  sessionId: "session_1234567890",
  godotVersion: "4.7.stable.official.test",
  addonVersion: "0.1.0",
  addonManifestSha256: "b".repeat(64),
  attachedAt: "2026-07-15T09:00:00.000Z",
};
const healthyDoctor = {
  healthy: true,
  checks: [{ name: "installation", status: "ok" as const, detail: "installed" }],
};

describe("SessionService", () => {
  it("moves from waiting to attached without exposing credentials", () => {
    const service = new SessionService(project, grants, async () => healthyDoctor);
    expect(service.snapshot().state).toBe("waiting_for_addon");

    service.onAttached(attached);
    const json = JSON.stringify(service.snapshot());

    expect(service.snapshot().state).toBe("attached");
    expect(json).not.toMatch(/token|sessionKey|authorization|descriptor|websocket/i);
    expect(json).toContain(attached.sessionId);
  });

  it("clears attachment data when disconnected and preserves only a safe error code", () => {
    const service = new SessionService(project, grants, async () => healthyDoctor);
    service.onAttached(attached);
    service.onDisconnected("AUTHENTICATION_FAILED");

    expect(service.snapshot()).toMatchObject({
      state: "disconnected",
      attachment: null,
      lastErrorCode: "AUTHENTICATION_FAILED",
    });
  });

  it("returns all six read-only core capabilities and merges doctor state", async () => {
    const service = new SessionService(project, grants, async () => healthyDoctor);

    expect(service.capabilities().operations).toEqual([
      "godot_capabilities",
      "godot_capture",
      "godot_doctor",
      "godot_help",
      "godot_query",
      "godot_session",
    ]);
    const report = await service.doctor();
    expect(report.healthy).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "bridge-session", status: "error" }),
    );
  });

  it("returns focused help and rejects unknown topics", () => {
    const service = new SessionService(project, grants, async () => healthyDoctor);
    expect(service.help("session").topic).toBe("session");
    expect(service.help("query")).toMatchObject({ topic: "query", tool: "godot_query" });
    expect(service.help("capture")).toMatchObject({ topic: "capture", tool: "godot_capture" });
    expect(() => service.help("shell" as never)).toThrowError(
      expect.objectContaining({ code: "TARGET_NOT_FOUND" }),
    );
  });
});
