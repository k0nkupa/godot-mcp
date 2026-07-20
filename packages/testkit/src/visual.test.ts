import { describe, expect, it } from "vitest";

import { createRgbaPng, readRgbaPng } from "./visual.js";

describe("visual test helpers", () => {
  it("creates and decodes deterministic RGBA PNGs", () => {
    const png = createRgbaPng(2, 2, (x, y) => [x * 10, y * 20, 30, 255]);
    const decoded = readRgbaPng(png);

    expect(decoded).toMatchObject({ width: 2, height: 2 });
    expect([...decoded.data]).toEqual([
      0, 0, 30, 255, 10, 0, 30, 255,
      0, 20, 30, 255, 10, 20, 30, 255,
    ]);
    expect(createRgbaPng(2, 2, (x, y) => [x * 10, y * 20, 30, 255])).toEqual(png);
  });
});
