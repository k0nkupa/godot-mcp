import { createHash } from "node:crypto";

import {
  EditorMutationInputSchema,
  EditorMutationResultSchema,
  type EditorMutationInput,
  type EditorMutationResult,
} from "@godot-mcp/protocol";

import { GodotMcpException } from "../errors.js";
import type { MutationLedger } from "./mutationLedger.js";

export interface EditorMutationBridge {
  request<T>(
    method: "editor.mutate",
    params: unknown,
    options: { timeoutMs: number; maxResponseBytes: number; correlationId: string },
  ): Promise<{ requestId: string; data: T }>;
}

type StableValue = null | boolean | number | string | StableValue[] | { [key: string]: StableValue };

function normalize(value: unknown, ancestors: Set<object>): StableValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Mutation digest accepts only finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw new TypeError(`Mutation digest does not support ${typeof value}`);
  if (ancestors.has(value)) throw new TypeError("Mutation digest does not support cyclic values");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => normalize(item, ancestors));
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Mutation digest accepts only arrays and plain objects");
    }
    const output: Record<string, StableValue> = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = normalize((value as Record<string, unknown>)[key], ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

export function editorMutationRequestDigest(input: EditorMutationInput): string {
  const parsed = EditorMutationInputSchema.parse(input);
  return createHash("sha256")
    .update(JSON.stringify(normalize(parsed, new Set<object>())))
    .digest("hex");
}

function exception(
  code: "INVALID_REQUEST" | "NOT_ATTACHED" | "CONFLICT",
  message: string,
  correlationId: string,
  partialEffects = false,
): GodotMcpException {
  return new GodotMcpException({
    code,
    message,
    retryable: code === "NOT_ATTACHED",
    correlationId,
    partialEffects,
    rollback: partialEffects ? "not_attempted" : "not_needed",
  });
}

export class EditorMutationService {
  constructor(
    private readonly bridge: () => EditorMutationBridge | null,
    private readonly ledger: MutationLedger,
  ) {}

  async execute(inputValue: EditorMutationInput, correlationId: string): Promise<EditorMutationResult> {
    const input = EditorMutationInputSchema.parse(inputValue);
    const bridge = this.bridge();
    if (!bridge) throw exception("NOT_ATTACHED", "Godot editor addon is not attached", correlationId);

    if (input.operation === "preview") {
      const response = await bridge.request<unknown>("editor.mutate", input, {
        timeoutMs: 10_000,
        maxResponseBytes: 512 * 1024,
        correlationId,
      });
      return this.validateTransition(input, response.data, correlationId);
    }

    const requestDigest = editorMutationRequestDigest(input);
    const reconciliation = await this.ledger.reconcile(input.idempotencyKey, requestDigest);
    if (reconciliation.state === "completed") return reconciliation.result;
    if (reconciliation.state === "unknown") {
      throw exception(
        "CONFLICT",
        "A prior mutation with this idempotency key has an unknown outcome; preview current targets and reconcile their revisions before retrying with a new key",
        correlationId,
        true,
      );
    }

    await this.ledger.begin({
      idempotencyKey: input.idempotencyKey,
      requestDigest,
      correlationId,
    });
    const response = await bridge.request<unknown>("editor.mutate", input, {
      timeoutMs: 30_000,
      maxResponseBytes: 512 * 1024,
      correlationId,
    });
    const result = this.validateTransition(input, response.data, correlationId);
    await this.ledger.complete({
      idempotencyKey: input.idempotencyKey,
      requestDigest,
      correlationId,
      result,
    });
    return result;
  }

  private validateTransition(
    input: EditorMutationInput,
    value: unknown,
    correlationId: string,
  ): EditorMutationResult {
    const parsed = EditorMutationResultSchema.safeParse(value);
    if (!parsed.success) {
      throw exception("INVALID_REQUEST", "Godot returned an invalid editor mutation result", correlationId);
    }
    const expectedState = input.operation === "preview"
      ? "previewed"
      : input.operation === "apply"
        ? "applied"
        : input.operation === "undo"
          ? "undone"
          : "redone";
    if (parsed.data.state !== expectedState) {
      throw exception("INVALID_REQUEST", `Godot returned ${parsed.data.state} for ${input.operation}`, correlationId);
    }
    if (input.operation === "apply" && parsed.data.planDigest !== input.expectedPlanDigest) {
      throw exception("INVALID_REQUEST", "Godot apply result plan digest did not match the authorized preview", correlationId);
    }
    if ((input.operation === "undo" || input.operation === "redo") && parsed.data.actionId !== input.actionId) {
      throw exception("INVALID_REQUEST", "Godot action result did not match the requested action", correlationId);
    }
    return parsed.data;
  }
}
