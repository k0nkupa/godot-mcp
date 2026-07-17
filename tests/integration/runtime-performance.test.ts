import { waitUntil } from "@godot-mcp/testkit";
import { expect, test } from "vitest";

import { createPhase7RuntimeFixture } from "./runtime-phase7-fixture.js";

test("captures completed and cancelled structured profiles from real Godot", async () => {
  const fixture = await createPhase7RuntimeFixture();
  let phase = "launch";
  try {
    const launched = await fixture.runtime.launch({ scenePath: "res://debug/debug_fixture.tscn", startupTimeoutMs: 15_000 });
    phase = "snapshot";
    const snapshot = await fixture.runtime.execute({
      operation: "monitor_snapshot",
      handle: launched.handle,
      groups: ["frame", "memory", "objects", "rendering", "custom"],
    }) as { groups: Record<string, Record<string, number>>; unavailable: string[] };
    expect(Object.keys(snapshot.groups).sort()).toEqual(["custom", "frame", "memory", "objects", "rendering"]);
    expect(snapshot.groups.custom).toMatchObject({ "Phase7/BreakpointHits": expect.any(Number), "Phase7/WorkloadTotal": expect.any(Number) });
    for (const group of Object.values(snapshot.groups)) {
      for (const value of Object.values(group)) expect(Number.isFinite(value)).toBe(true);
    }

    phase = "complete-profile";
    const started = await fixture.runtime.execute({
      operation: "profile_start",
      handle: launched.handle,
      durationMs: 300,
      intervalFrames: 1,
      groups: ["frame", "memory", "objects", "custom"],
      retainRaw: true,
    }) as { jobToken: string };
    phase = "poll-complete-profile";
    let state = "running";
    await waitUntil(async () => {
      const status = await fixture.runtime.execute({ operation: "profile_status", handle: launched.handle, jobToken: started.jobToken }) as { state: string };
      state = status.state;
      return state !== "running";
    }, 5_000, 25);
    expect(state).toBe("completed");
    phase = "read-complete-profile";
    const completed = await fixture.runtime.execute({ operation: "profile_result", handle: launched.handle, jobToken: started.jobToken }) as {
      state: string;
      evidence: { complete: boolean; observedSamples: number; retainedSamples: number; rawSamples: unknown[]; aggregates: Record<string, unknown>; sha256: string };
    };
    expect(completed).toMatchObject({ state: "completed", evidence: { complete: true, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(completed.evidence.observedSamples).toBeGreaterThan(0);
    expect(completed.evidence.retainedSamples).toBe(completed.evidence.rawSamples.length);
    expect(Object.keys(completed.evidence.aggregates)).toEqual(expect.arrayContaining(["frame.fps", "custom.Phase7/WorkloadTotal"]));

    phase = "cancel-profile";
    const cancellable = await fixture.runtime.execute({
      operation: "profile_start",
      handle: launched.handle,
      durationMs: 30_000,
      intervalFrames: 1,
      groups: ["frame", "custom"],
      retainRaw: false,
    }) as { jobToken: string };
    const cancelled = await fixture.runtime.execute({ operation: "profile_cancel", handle: launched.handle, jobToken: cancellable.jobToken });
    expect(cancelled).toMatchObject({ state: "cancelled" });
    const partial = await fixture.runtime.execute({ operation: "profile_result", handle: launched.handle, jobToken: cancellable.jobToken }) as {
      evidence: { complete: boolean; state: string; rawSamples: unknown[]; terminalReason: string };
    };
    expect(partial.evidence).toMatchObject({ complete: false, state: "cancelled", rawSamples: [], terminalReason: "Profile cancelled by request" });
    await fixture.runtime.execute({ operation: "stop", handle: launched.handle });
  } catch (error) {
    throw new Error(`Phase: ${phase}\n${String(error)}\n${fixture.diagnostics()}`);
  } finally {
    await fixture.close();
  }
}, 60_000);
