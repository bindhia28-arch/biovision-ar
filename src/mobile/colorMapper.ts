import type { ColorMap, Vector3 } from "../core/types.js";

export interface RGBFrame {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export function mapSkinRedness(frame: RGBFrame, capturedAt = new Date().toISOString()): ColorMap {
  if (frame.pixels.length !== frame.width * frame.height * 3) {
    throw new RangeError("RGB frame does not match its dimensions");
  }
  const redYellowRatio: number[] = [];
  for (let index = 0; index < frame.pixels.length; index += 3) {
    const red = frame.pixels[index] ?? 0;
    const green = frame.pixels[index + 1] ?? 0;
    const blue = frame.pixels[index + 2] ?? 0;
    redYellowRatio.push(red / Math.max(1, (red + green) / 2 + blue * 0.1));
  }
  return { width: frame.width, height: frame.height, redYellowRatio, boundary: [], capturedAt };
}

export function withBoundary(colorMap: ColorMap, boundary: readonly Vector3[]): ColorMap {
  return { ...colorMap, boundary: [...boundary] };
}
