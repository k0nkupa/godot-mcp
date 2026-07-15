import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "./index.js";

describe("canonicalJson", () => {
  it("canonicalizes nested objects deterministically while preserving array order", () => {
    expect(canonicalJson({ z: 1, a: { y: true, x: [2, 1] } })).toBe(
      '{"a":{"x":[2,1],"y":true},"z":1}',
    );
  });

  it("supports null, strings, booleans, and safe integer boundaries", () => {
    expect(
      canonicalJson({
        max: Number.MAX_SAFE_INTEGER,
        min: Number.MIN_SAFE_INTEGER,
        nothing: null,
        text: "Godot \u2603",
        truth: false,
        zero: 0,
      }),
    ).toBe(
      '{"max":9007199254740991,"min":-9007199254740991,"nothing":null,"text":"Godot ☃","truth":false,"zero":0}',
    );
  });

  it("matches the shared canonical JSON v1 fixture", async () => {
    const fixturePath = new URL("../fixtures/canonical-json-v1.json", import.meta.url);
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
      input: unknown;
      canonical: string;
    };

    expect(canonicalJson(fixture.input)).toBe(fixture.canonical);
  });

  it.each([
    ["undefined", undefined],
    ["bigint", 1n],
    ["function", () => undefined],
    ["symbol", Symbol("value")],
    ["non-finite number", Number.POSITIVE_INFINITY],
    ["floating-point number", 1.5],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects %s values", (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });

  it("rejects cycles", () => {
    const value: Record<string, unknown> = {};
    value.self = value;

    expect(() => canonicalJson(value)).toThrow(TypeError);
  });
});
