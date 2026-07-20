import { createHash, randomUUID } from "node:crypto";

import {
  canonicalJson,
  VisualComparisonResultSchema,
  VisualComparisonSettingsSchema,
  type VisualComparisonResult,
  type VisualComparisonSettings,
} from "@godot-mcp/protocol";
import { PNG } from "pngjs";

import { GodotMcpException } from "../errors.js";

const MAX_PNG_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 4_194_304;

export interface ComparePngInput {
  baseline: Uint8Array;
  current: Uint8Array;
  settings: unknown;
}

export interface ComparePngOutput {
  result: VisualComparisonResult;
  diffPng?: Uint8Array;
}

interface DecodedPng {
  width: number;
  height: number;
  data: Buffer;
}

function comparisonError(code: "INVALID_REQUEST" | "PAYLOAD_TOO_LARGE", message: string): GodotMcpException {
  return new GodotMcpException({
    code,
    message,
    retryable: false,
    correlationId: randomUUID(),
    partialEffects: false,
    rollback: "not_needed",
  });
}

function decodePng(bytes: Uint8Array): DecodedPng {
  if (bytes.byteLength > MAX_PNG_BYTES) throw comparisonError("PAYLOAD_TOO_LARGE", "Visual comparison PNG exceeds eight MiB");
  let decoded: PNG;
  try {
    decoded = PNG.sync.read(Buffer.from(bytes));
  } catch {
    throw comparisonError("INVALID_REQUEST", "Visual comparison input is not a valid PNG");
  }
  if (
    !Number.isInteger(decoded.width) || !Number.isInteger(decoded.height) ||
    decoded.width < 1 || decoded.height < 1 ||
    decoded.width > 2048 || decoded.height > 2048 ||
    decoded.width * decoded.height > MAX_PIXELS ||
    decoded.data.byteLength !== decoded.width * decoded.height * 4
  ) throw comparisonError("PAYLOAD_TOO_LARGE", "Visual comparison PNG dimensions exceed certified bounds");
  return { width: decoded.width, height: decoded.height, data: decoded.data };
}

function rectInside(rect: { x: number; y: number; width: number; height: number }, width: number, height: number): boolean {
  return rect.x + rect.width <= width && rect.y + rect.height <= height;
}

function pointInside(x: number, y: number, rect: { x: number; y: number; width: number; height: number }): boolean {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
}

function validateGeometry(settings: VisualComparisonSettings, width: number, height: number): Required<Pick<VisualComparisonSettings, "masks">> & VisualComparisonSettings {
  const region = settings.region ?? { x: 0, y: 0, width, height };
  if (!rectInside(region, width, height)) throw comparisonError("INVALID_REQUEST", "Visual comparison region exceeds image bounds");
  for (const mask of settings.masks) {
    if (!rectInside(mask, width, height)) throw comparisonError("INVALID_REQUEST", "Visual comparison mask exceeds image bounds");
  }
  return { ...settings, region };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function comparePng(input: ComparePngInput): ComparePngOutput {
  const baseline = decodePng(input.baseline);
  const current = decodePng(input.current);
  if (baseline.width !== current.width || baseline.height !== current.height) {
    throw comparisonError("INVALID_REQUEST", "Visual comparison image dimensions do not match");
  }
  const parsedSettings = VisualComparisonSettingsSchema.parse(input.settings);
  const settings = validateGeometry(parsedSettings, baseline.width, baseline.height);
  const region = settings.region!;
  let comparedPixels = 0;
  let maskedPixels = 0;
  let differentPixels = 0;
  let maxObservedChannelDelta = 0;
  const differentOffsets: number[] = [];
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      if (settings.masks.some((mask) => pointInside(x, y, mask))) {
        maskedPixels += 1;
        continue;
      }
      comparedPixels += 1;
      const offset = (y * baseline.width + x) * 4;
      let pixelDelta = 0;
      for (let channel = 0; channel < 4; channel += 1) {
        pixelDelta = Math.max(pixelDelta, Math.abs(baseline.data[offset + channel]! - current.data[offset + channel]!));
      }
      maxObservedChannelDelta = Math.max(maxObservedChannelDelta, pixelDelta);
      if (pixelDelta > settings.maxChannelDelta) {
        differentPixels += 1;
        differentOffsets.push(offset);
      }
    }
  }
  const differentRatioMillionths = comparedPixels === 0
    ? 0
    : Math.floor(differentPixels * 1_000_000 / comparedPixels);
  const passed = differentPixels <= settings.maxDifferentPixels &&
    differentRatioMillionths <= settings.maxDifferentRatioMillionths;
  const resultWithoutDigest = {
    passed,
    comparedPixels,
    maskedPixels,
    differentPixels,
    differentRatioMillionths,
    maxObservedChannelDelta,
    baselineSha256: digest(input.baseline),
    currentSha256: digest(input.current),
    settings: parsedSettings,
  };
  const result = VisualComparisonResultSchema.parse({
    ...resultWithoutDigest,
    resultSha256: digest(Buffer.from(canonicalJson(resultWithoutDigest), "utf8")),
  });
  if (passed) return { result };
  const diff = new PNG({ width: current.width, height: current.height });
  current.data.copy(diff.data);
  for (const offset of differentOffsets) {
    diff.data[offset] = 255;
    diff.data[offset + 1] = 0;
    diff.data[offset + 2] = 0;
    diff.data[offset + 3] = 255;
  }
  return { result, diffPng: PNG.sync.write(diff, { colorType: 6, inputColorType: 6 }) };
}
