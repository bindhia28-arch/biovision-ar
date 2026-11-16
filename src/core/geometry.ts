import type { MeshPoint, ScanMetrics, Vector3 } from "./types.js";

export function subtract(a: Vector3, b: Vector3): Vector3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function dot(a: Vector3, b: Vector3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function magnitude(value: Vector3): number {
  return Math.sqrt(dot(value, value));
}

export function jointAngleDegrees(a: Vector3, vertex: Vector3, c: Vector3): number {
  const first = subtract(a, vertex);
  const second = subtract(c, vertex);
  const denominator = magnitude(first) * magnitude(second);
  if (denominator === 0) {
    throw new RangeError("Cannot calculate a joint angle from a zero-length vector");
  }
  const cosine = Math.max(-1, Math.min(1, dot(first, second) / denominator));
  return Math.acos(cosine) * (180 / Math.PI);
}

export function volumeDifferential(current: number, baseline: number): number {
  if (baseline <= 0) {
    throw new RangeError("Baseline volume must be greater than zero");
  }
  return current - baseline;
}

export function swellingPercent(current: number, baseline: number): number {
  return (volumeDifferential(current, baseline) / baseline) * 100;
}

export function isSwellingSpike(current: number, baseline: number, thresholdPercent = 5): boolean {
  return swellingPercent(current, baseline) > thresholdPercent;
}

/**
 * Computes the metrics from a closed triangle mesh. Coordinates are expected in cm.
 */
export function triangleMeshMetrics(points: readonly MeshPoint[], triangles: readonly [number, number, number][]): ScanMetrics {
  let volume = 0;
  let area = 0;
  let perimeter = 0;
  for (const [aIndex, bIndex, cIndex] of triangles) {
    const a = points[aIndex];
    const b = points[bIndex];
    const c = points[cIndex];
    if (!a || !b || !c) {
      throw new RangeError("Triangle references a missing mesh point");
    }
    const ab = subtract(b, a);
    const ac = subtract(c, a);
    const cross = {
      x: ab.y * ac.z - ab.z * ac.y,
      y: ab.z * ac.x - ab.x * ac.z,
      z: ab.x * ac.y - ab.y * ac.x
    };
    area += magnitude(cross) / 2;
    volume += dot(a, cross) / 6;
    perimeter += magnitude(ab) + magnitude(subtract(c, b)) + magnitude(subtract(a, c));
  }
  return { volumeCm3: Math.abs(volume), surfaceAreaCm2: area, perimeterCm: perimeter };
}
