import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EditorMutationResult } from "@godot-mcp/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { MutationLedger } from "./mutationLedger.js";

const directories: string[] = [];
const key = "019f6f52-6b15-7e21-bda3-101112131415";
const requestDigest = "a".repeat(64);
const result: EditorMutationResult = {
  state: "applied",
  actionId: "019f6f52-6b15-7e21-bda3-202122232425",
  planDigest: "b".repeat(64),
  history: { kind: "global" },
  preconditions: [],
  changes: [],
  warnings: [],
  audit: {
    targetIdentities: [],
    preconditions: [],
    idempotencyKeySha256: "c".repeat(64),
    partialEffects: false,
    rollback: "not_needed",
  },
};

async function ledgerPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "godot-mcp-mutation-ledger-"));
  directories.push(directory);
  return join(directory, "nested", "mutation-journal.jsonl");
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("MutationLedger", () => {
  it("returns a completed receipt without exposing the raw idempotency key", async () => {
    const path = await ledgerPath();
    const ledger = await MutationLedger.open(path);
    await ledger.begin({ idempotencyKey: key, requestDigest, correlationId: "req-1" });
    await ledger.complete({ idempotencyKey: key, requestDigest, correlationId: "req-1", result });

    await expect((await MutationLedger.open(path)).reconcile(key, requestDigest)).resolves.toEqual({
      state: "completed",
      result,
    });
    expect(await readFile(path, "utf8")).not.toContain(key);
  });

  it("rejects key reuse and reports a started record as an unknown outcome", async () => {
    const path = await ledgerPath();
    const ledger = await MutationLedger.open(path);
    await ledger.begin({ idempotencyKey: key, requestDigest, correlationId: "req-1" });

    await expect(ledger.reconcile(key, "b".repeat(64))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(ledger.reconcile(key, requestDigest)).resolves.toEqual({ state: "unknown" });
    await expect(ledger.reconcile("019f6f52-6b15-7e21-bda3-303132333435", requestDigest)).resolves.toEqual({ state: "missing" });
  });

  it("serializes concurrent appends and restores the latest 256 keys", async () => {
    const path = await ledgerPath();
    const ledger = await MutationLedger.open(path);
    await Promise.all(Array.from({ length: 260 }, (_, index) => ledger.begin({
      idempotencyKey: `019f6f52-6b15-7e21-bda3-${String(index).padStart(12, "0")}`,
      requestDigest,
      correlationId: `req-${index}`,
    })));
    const reopened = await MutationLedger.open(path);
    await expect(reopened.reconcile("019f6f52-6b15-7e21-bda3-000000000000", requestDigest)).resolves.toEqual({ state: "missing" });
    await expect(reopened.reconcile("019f6f52-6b15-7e21-bda3-000000000259", requestDigest)).resolves.toEqual({ state: "unknown" });
  });
});
