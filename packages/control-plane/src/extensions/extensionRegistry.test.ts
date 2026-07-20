import { z } from "zod";
import { expect, it } from "vitest";
import { CORE_QUERY_POLICY, UNSAFE_POLICY } from "../policy/capabilities.js";
import { ExtensionRegistry } from "./extensionRegistry.js";

it("registers unique typed operations and exposes only grant-visible definitions", () => {
  const registry = new ExtensionRegistry();
  registry.register({ extension: "fixture", operation: "count", policy: CORE_QUERY_POLICY, inputSchema: z.object({ count: z.number().int() }).strict(), outputSchema: z.number().int(), audit: (input) => ({ count: input.count }), handler: async (_context, input) => input.count });
  expect(registry.visible({ tiers: ["observe"], packs: ["core"] })).toBe(true);
  expect(registry.list()).toHaveLength(1);
  expect(() => registry.register({ extension: "fixture", operation: "count", policy: CORE_QUERY_POLICY, inputSchema: z.unknown(), outputSchema: z.unknown(), audit: () => ({}), handler: async () => null })).toThrow(/duplicate/i);
});

it("denies unsafe authority and invalid dynamic names", () => {
  const registry = new ExtensionRegistry();
  expect(() => registry.register({ extension: "fixture", operation: "exec", policy: UNSAFE_POLICY, inputSchema: z.unknown(), outputSchema: z.unknown(), audit: () => ({}), handler: async () => null })).toThrow(/unsafe/i);
  expect(() => registry.register({ extension: "../escape", operation: "read", policy: CORE_QUERY_POLICY, inputSchema: z.unknown(), outputSchema: z.unknown(), audit: () => ({}), handler: async () => null })).toThrow(/identifiers/i);
  expect(() => registry.register({ extension: "fixture", operation: "fake", policy: { ...CORE_QUERY_POLICY, command: "forged" }, inputSchema: z.unknown(), outputSchema: z.unknown(), audit: () => ({}), handler: async () => null })).toThrow(/exact existing/i);
});

it("snapshots validated definitions and policies", () => {
  const registry = new ExtensionRegistry();
  const definition = { extension: "fixture", operation: "read", policy: { ...CORE_QUERY_POLICY }, inputSchema: z.unknown(), outputSchema: z.unknown(), audit: () => ({}), handler: async () => null };
  registry.register(definition);
  definition.policy.command = "forged";
  expect(registry.resolve("fixture", "read").policy.command).toBe(CORE_QUERY_POLICY.command);
  expect(Object.isFrozen(registry.resolve("fixture", "read"))).toBe(true);
  expect(Object.isFrozen(registry.resolve("fixture", "read").policy)).toBe(true);
});
