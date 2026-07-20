import { createHash } from "node:crypto";

import { createRgbaPng, readRgbaPng } from "@godot-mcp/testkit";
import { describe, expect, it } from "vitest";

import { comparePng } from "./pngComparison.js";

const black = createRgbaPng(4, 4, () => [0, 0, 0, 255]);

function settings(overrides: Record<string, unknown> = {}) {
  return {
    masks: [],
    maxChannelDelta: 0,
    maxDifferentPixels: 0,
    maxDifferentRatioMillionths: 0,
    ...overrides,
  };
}

describe("comparePng", () => {
  it("reports exact equality without diff evidence", () => {
    const compared = comparePng({ baseline: black, current: black, settings: settings() });

    expect(compared.diffPng).toBeUndefined();
    expect(compared.result).toMatchObject({
      passed: true,
      comparedPixels: 16,
      maskedPixels: 0,
      differentPixels: 0,
      differentRatioMillionths: 0,
      maxObservedChannelDelta: 0,
      baselineSha256: createHash("sha256").update(black).digest("hex"),
      currentSha256: createHash("sha256").update(black).digest("hex"),
    });
  });

  it("uses an inclusive channel tolerance and requires both difference limits", () => {
    const current = createRgbaPng(4, 4, (x, y) => x === 1 && y === 2 ? [10, 0, 0, 255] : [0, 0, 0, 255]);

    expect(comparePng({ baseline: black, current, settings: settings({ maxChannelDelta: 10 }) }).result.passed).toBe(true);
    expect(comparePng({ baseline: black, current, settings: settings({ maxDifferentPixels: 1, maxDifferentRatioMillionths: 62_499 }) }).result)
      .toMatchObject({ passed: false, differentPixels: 1, differentRatioMillionths: 62_500, maxObservedChannelDelta: 10 });
    expect(comparePng({ baseline: black, current, settings: settings({ maxDifferentPixels: 0, maxDifferentRatioMillionths: 1_000_000 }) }).result.passed)
      .toBe(false);
  });

  it("applies regions and masks before difference accounting", () => {
    const current = createRgbaPng(4, 4, (x, y) => x === 3 && y === 3 ? [255, 255, 255, 255] : [0, 0, 0, 255]);

    expect(comparePng({
      baseline: black,
      current,
      settings: settings({ region: { x: 0, y: 0, width: 2, height: 2 } }),
    }).result).toMatchObject({ passed: true, comparedPixels: 4, maskedPixels: 0 });
    expect(comparePng({
      baseline: black,
      current,
      settings: settings({ masks: [{ x: 3, y: 3, width: 1, height: 1 }] }),
    }).result).toMatchObject({ passed: true, comparedPixels: 15, maskedPixels: 1, differentPixels: 0 });
  });

  it("compares alpha and produces a deterministic red-highlight diff", () => {
    const current = createRgbaPng(4, 4, (x, y) => x === 0 && y === 0 ? [0, 0, 0, 254] : [0, 0, 0, 255]);
    const first = comparePng({ baseline: black, current, settings: settings() });
    const second = comparePng({ baseline: black, current, settings: settings() });

    expect(first.result).toMatchObject({ passed: false, differentPixels: 1, maxObservedChannelDelta: 1 });
    expect(first.result.resultSha256).toBe(second.result.resultSha256);
    expect(first.diffPng).toEqual(second.diffPng);
    expect([...readRgbaPng(first.diffPng!).data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
  });

  it("rejects malformed, mismatched, oversized, and out-of-bounds images or geometry", () => {
    expect(() => comparePng({ baseline: Buffer.from("bad"), current: black, settings: settings() })).toThrow(/PNG/i);
    expect(() => comparePng({ baseline: black, current: createRgbaPng(3, 4, () => [0, 0, 0, 255]), settings: settings() })).toThrow(/dimensions/i);
    expect(() => comparePng({ baseline: black, current: black, settings: settings({ region: { x: 3, y: 3, width: 2, height: 2 } }) })).toThrow(/bounds/i);
    expect(() => comparePng({ baseline: black, current: black, settings: settings({ masks: [{ x: 4, y: 0, width: 1, height: 1 }] }) })).toThrow(/bounds/i);
    expect(() => comparePng({ baseline: createRgbaPng(2048, 2048, () => [0, 0, 0, 0]), current: black, settings: settings() })).toThrow(/dimensions/i);
  });

  it("rejects hostile IHDR dimensions before attempting to decode pixels", () => {
    const hostile = Buffer.from(black);
    hostile.writeUInt32BE(2049, 16);

    expect(() => comparePng({ baseline: hostile, current: black, settings: settings() }))
      .toThrowError(expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" }));
  });
});
