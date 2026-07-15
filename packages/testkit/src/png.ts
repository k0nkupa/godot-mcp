import { PNG } from "pngjs";

export interface PngInspection {
  width: number;
  height: number;
  uniqueColors: number;
}

export function inspectPng(bytes: Uint8Array): PngInspection {
  const png = PNG.sync.read(Buffer.from(bytes));
  const colors = new Set<string>();
  for (let index = 0; index < png.data.length && colors.size < 32; index += 4) {
    colors.add(
      `${png.data[index]}:${png.data[index + 1]}:${png.data[index + 2]}:${png.data[index + 3]}`,
    );
  }
  return { width: png.width, height: png.height, uniqueColors: colors.size };
}
