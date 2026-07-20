import { PNG } from "pngjs";

export type RgbaPixel = readonly [red: number, green: number, blue: number, alpha: number];

export interface DecodedRgbaPng {
  width: number;
  height: number;
  data: Uint8Array;
}

export function createRgbaPng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => RgbaPixel,
): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 2048 || height > 2048) {
    throw new RangeError("PNG dimensions must be integers between 1 and 2048");
  }
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const rgba = pixel(x, y);
      if (rgba.length !== 4 || rgba.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
        throw new RangeError("RGBA channels must be integers between 0 and 255");
      }
      const offset = (y * width + x) * 4;
      png.data[offset] = rgba[0];
      png.data[offset + 1] = rgba[1];
      png.data[offset + 2] = rgba[2];
      png.data[offset + 3] = rgba[3];
    }
  }
  return PNG.sync.write(png, { colorType: 6, inputColorType: 6 });
}

export function readRgbaPng(bytes: Uint8Array): DecodedRgbaPng {
  const decoded = PNG.sync.read(Buffer.from(bytes));
  return { width: decoded.width, height: decoded.height, data: decoded.data };
}
