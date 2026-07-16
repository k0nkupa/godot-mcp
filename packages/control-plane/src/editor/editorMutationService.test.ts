import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EditorMutationInput, EditorMutationResult } from "@godot-mcp/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EditorMutationService,
  editorMutationRequestDigest,
  type EditorMutationBridge,
} from "./editorMutationService.js";
import { MutationLedger } from "./mutationLedger.js";

const directories: string[] = [];
const scenePath = "res://mutation/editor_mutation.tscn";
const idempotencyKey = "019f6f52-6b15-7e21-bda3-101112131415";
const actionId = "019f6f52-6b15-7e21-bda3-202122232425";
const planDigest = "a".repeat(64);
const steps = [{
  operation: "set_property" as const,
  scenePath,
  nodePath: "Target",
  property: "position",
  value: { type: "vector2" as const, x: 1.5, y: 2.25 },
}];

function result(state: EditorMutationResult["state"]): EditorMutationResult {
  return {
    state,
    ...(state === "previewed" ? {} : { actionId }),
    planDigest,
    history: { kind: "scene", scenePath },
    preconditions: [],
    changes: [],
    warnings: [],
    audit: {
      targetIdentities: [],
      preconditions: [],
      idempotencyKeySha256: state === "previewed" ? null : "b".repeat(64),
      partialEffects: false,
      rollback: "not_needed",
    },
  };
}

async function setup(response: EditorMutationResult) {
  const directory = await mkdtemp(join(tmpdir(), "godot-mcp-editor-service-"));
  directories.push(directory);
  const ledger = await MutationLedger.open(join(directory, "mutation-journal.jsonl"));
  const request = vi.fn(async (method: string, params: unknown, options: unknown) => {
    void method;
    void params;
    void options;
    return { requestId: "req-1", data: response };
  });
  const bridge: EditorMutationBridge = {
    request: async <T>(method: "editor.mutate", params: unknown, options: { timeoutMs: number; maxResponseBytes: number; correlationId: string }) => {
      const output = await request(method, params, options);
      return { requestId: output.requestId, data: output.data as T };
    },
  };
  return { service: new EditorMutationService(() => bridge, ledger), ledger, request };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("EditorMutationService", () => {
  it("previews without writing the idempotency ledger", async () => {
    const { service, request } = await setup(result("previewed"));
    const output = await service.execute({ operation: "preview", steps }, "req-1");
    expect(output.state).toBe("previewed");
    expect(request).toHaveBeenCalledWith("editor.mutate", { operation: "preview", steps }, {
      timeoutMs: 10_000,
      maxResponseBytes: 512 * 1024,
      correlationId: "req-1",
    });
  });

  it("journals apply before dispatch and returns a completed retry without redispatch", async () => {
    const input: EditorMutationInput = { operation: "apply", idempotencyKey, expectedPlanDigest: planDigest, steps };
    const { service, request } = await setup(result("applied"));
    await expect(service.execute(input, "req-1")).resolves.toMatchObject({ state: "applied", actionId });
    await expect(service.execute(input, "req-2")).resolves.toMatchObject({ state: "applied", actionId });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("editor.mutate", input, {
      timeoutMs: 30_000,
      maxResponseBytes: 512 * 1024,
      correlationId: "req-1",
    });
  });

  it("refuses to repeat a mutation whose prior outcome is unknown", async () => {
    const input: EditorMutationInput = { operation: "apply", idempotencyKey, expectedPlanDigest: planDigest, steps };
    const { service, ledger, request } = await setup(result("applied"));
    await ledger.begin({ idempotencyKey, requestDigest: editorMutationRequestDigest(input), correlationId: "req-old" });
    await expect(service.execute(input, "req-new")).rejects.toMatchObject({
      code: "CONFLICT",
      partialEffects: true,
      rollback: "not_attempted",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a response that does not match the requested transition", async () => {
    const input: EditorMutationInput = { operation: "apply", idempotencyKey, expectedPlanDigest: planDigest, steps };
    const { service } = await setup(result("previewed"));
    await expect(service.execute(input, "req-1")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("hashes semantically identical dictionaries deterministically and supports finite decimals", () => {
    const left: EditorMutationInput = { operation: "preview", steps: [{ operation: "set_metadata", scenePath, nodePath: "Target", key: "data", value: { b: 2.5, a: 1.25 } }] };
    const right: EditorMutationInput = { operation: "preview", steps: [{ operation: "set_metadata", scenePath, nodePath: "Target", key: "data", value: { a: 1.25, b: 2.5 } }] };
    expect(editorMutationRequestDigest(left)).toBe(editorMutationRequestDigest(right));
  });
});
