import { describe, expect, it } from "vitest";
import { UnsafeFixtureJobReceiptSchema, UnsafeFixtureOperationInputSchema } from "./unsafeFixture.js";

describe("unsafe fixture protocol", () => {
  it("accepts only bounded inline GDScript and opaque jobs", () => {
    expect(UnsafeFixtureOperationInputSchema.parse({ operation: "execute_start", source: "extends SceneTree\nfunc _init(): quit()" })).toMatchObject({ deadlineMs: 10_000 });
    expect(() => UnsafeFixtureOperationInputSchema.parse({ operation: "execute_start", source: "x".repeat(65_537) })).toThrow();
    expect(() => UnsafeFixtureOperationInputSchema.parse({ operation: "execute_start", source: "é".repeat(40_000) })).toThrow(/64 KiB/i);
    expect(() => UnsafeFixtureOperationInputSchema.parse({ operation: "execute_start", source: "ok\0bad" })).toThrow();
    expect(() => UnsafeFixtureOperationInputSchema.parse({ operation: "execute_start", source: "ok", executable: "/bin/sh" })).toThrow();
    expect(() => UnsafeFixtureOperationInputSchema.parse({ operation: "job_status", jobToken: "ujob_guessable" })).toThrow();
    expect(UnsafeFixtureOperationInputSchema.safeParse({ operation: "job_status", jobToken: `ujob_${"A".repeat(43)}` }).success).toBe(true);
  });
  it("requires every receipt to state that execution is unsandboxed", () => {
    expect(() => UnsafeFixtureJobReceiptSchema.parse({ jobToken: `ujob_${"A".repeat(43)}`, state: "running", unsafe: true, expiresAt: new Date().toISOString() })).toThrow();
    expect(UnsafeFixtureJobReceiptSchema.safeParse({ jobToken: `ujob_${"A".repeat(43)}`, state: "running", unsafe: true, sandboxed: false, expiresAt: new Date().toISOString() }).success).toBe(true);
  });
});
