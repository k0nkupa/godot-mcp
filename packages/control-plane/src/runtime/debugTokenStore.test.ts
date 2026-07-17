import { describe, expect, it } from "vitest";

import { DebugTokenStore, DebugTokenStoreError } from "./debugTokenStore.js";

const first = {
  runId: "019f644c-1379-79c0-825e-66a4b7653bd1",
  generation: 1,
  dapGeneration: 1,
  stopSequence: 1,
};

describe("stop-bound debugger tokens", () => {
  it("issues opaque frame and variable tokens without exposing DAP IDs", () => {
    const store = new DebugTokenStore();
    store.bind(first);
    const frameToken = store.issueFrame(7);
    const variableToken = store.issueVariable(99, 1);
    expect(frameToken).toMatch(/^dft_[A-Za-z0-9_-]{43}$/);
    expect(variableToken).toMatch(/^dvt_[A-Za-z0-9_-]{43}$/);
    expect(frameToken).not.toBe("7");
    expect(variableToken).not.toBe("99");
    expect(store.resolveFrame(frameToken)).toBe(7);
    expect(store.resolveVariable(variableToken)).toEqual({ variablesReference: 99, depth: 1 });
    expect(store.issueFrame(7)).toBe(frameToken);
  });

  it("invalidates every token when stop, DAP, run, or generation identity changes", () => {
    for (const changed of [
      { ...first, stopSequence: 2 },
      { ...first, dapGeneration: 2 },
      { ...first, generation: 2 },
      { ...first, runId: "019f644c-1379-79c0-825e-66a4b7653bd2" },
    ]) {
      const store = new DebugTokenStore();
      store.bind(first);
      const token = store.issueFrame(1);
      store.bind(changed);
      expect(() => store.resolveFrame(token)).toThrow(DebugTokenStoreError);
    }
  });

  it("enforces depth and total-token limits", () => {
    const store = new DebugTokenStore({ maxVariables: 2, maxDepth: 2 });
    store.bind(first);
    store.issueVariable(1, 1);
    store.issueVariable(2, 2);
    expect(() => store.issueVariable(3, 1)).toThrow(/limit/i);
    store.clear();
    store.bind(first);
    expect(() => store.issueVariable(4, 3)).toThrow(/depth/i);
  });

  it("bounds every returned variable entry, including leaves", () => {
    const store = new DebugTokenStore({ maxVariables: 2 });
    store.bind(first);
    store.consumeVariableEntries(2);
    expect(() => store.consumeVariableEntries(1)).toThrow("variable entry limit exceeded");
  });

  it("rejects cross-kind and unknown tokens", () => {
    const store = new DebugTokenStore();
    store.bind(first);
    const frame = store.issueFrame(1);
    const variable = store.issueVariable(2, 1);
    expect(() => store.resolveFrame(variable)).toThrow(DebugTokenStoreError);
    expect(() => store.resolveVariable(frame)).toThrow(DebugTokenStoreError);
    expect(() => store.resolveFrame(`dft_${"z".repeat(43)}`)).toThrow(DebugTokenStoreError);
  });
});
