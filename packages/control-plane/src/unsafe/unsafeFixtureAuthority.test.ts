import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyFixture } from "@godot-mcp/testkit";
import { expect, it } from "vitest";
import { approveUnsafeFixtureCopy, consumeUnsafeFixtureActivation, registerUnsafeFixture, stampUnsafeFixtureCopy, UNSAFE_CONFIRMATION_PHRASE } from "./unsafeFixtureAuthority.js";

it("requires registration, a distinct stamped copy, exact confirmation, and a one-use short lease", async () => {
  const template = await copyFixture();
  const container = await mkdtemp(join(tmpdir(), "godot-mcp-unsafe-authority-"));
  const registry = join(container, "registry.json");
  const copy = join(container, "copy");
  try {
    await expect(registerUnsafeFixture(registry, template.root, "yes")).rejects.toThrow(/confirmation/i);
    const registration = await registerUnsafeFixture(registry, template.root, UNSAFE_CONFIRMATION_PHRASE);
    await expect(stampUnsafeFixtureCopy(registry, template.root, registration.registrationId)).rejects.toThrow(/copy/i);
    await cp(template.root, copy, { recursive: true });
    await stampUnsafeFixtureCopy(registry, copy, registration.registrationId);
    const approved = await approveUnsafeFixtureCopy(registry, copy, container, UNSAFE_CONFIRMATION_PHRASE, 2_000);
    await expect(consumeUnsafeFixtureActivation(registry, copy, approved.leasePath)).resolves.toMatchObject({ registrationId: registration.registrationId, copyRoot: expect.stringContaining("godot-mcp-unsafe-authority-") });
    await expect(readFile(approved.leasePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(consumeUnsafeFixtureActivation(registry, copy, approved.leasePath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await template.cleanup(); await rm(container, { recursive: true, force: true }); }
});

it("consumes and rejects an expired activation", async () => {
  const template = await copyFixture(); const container = await mkdtemp(join(tmpdir(), "godot-mcp-unsafe-expiry-")); const copy = join(container, "copy"); const registry = join(container, "registry.json");
  try {
    const registration = await registerUnsafeFixture(registry, template.root, UNSAFE_CONFIRMATION_PHRASE); await cp(template.root, copy, { recursive: true }); await stampUnsafeFixtureCopy(registry, copy, registration.registrationId);
    const approved = await approveUnsafeFixtureCopy(registry, copy, container, UNSAFE_CONFIRMATION_PHRASE, 1_000);
    await expect(consumeUnsafeFixtureActivation(registry, copy, approved.leasePath, Date.parse(approved.expiresAt) + 1)).rejects.toThrow(/expired/i);
    await expect(readFile(approved.leasePath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await template.cleanup(); await rm(container, { recursive: true, force: true }); }
});
