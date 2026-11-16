import assert from "node:assert/strict";
import test from "node:test";
import { compareToBaseline, getBaselineStatus } from "../src/mobile/useBaselineCompare.js";
import type { ScanRecord } from "../src/core/types.js";

const scan = (id: string, capturedAt: string, volumeCm3: number): ScanRecord => ({
  id,
  capturedAt,
  bodyRegion: "left-knee",
  mesh: [],
  joints: [],
  metrics: { volumeCm3, surfaceAreaCm2: 1, perimeterCm: 1 }
});

test("locks advanced analysis when baseline is older than 30 days", () => {
  const baseline = scan("baseline", "2026-01-01T00:00:00.000Z", 100);
  const status = getBaselineStatus(baseline, new Date("2026-02-01T00:00:00.000Z"));
  assert.equal(status.advancedAnalysisLocked, true);
});

test("flags volume increases above the five percent threshold", () => {
  const baseline = scan("baseline", "2026-01-01T00:00:00.000Z", 100);
  const current = scan("current", "2026-01-15T00:00:00.000Z", 106);
  assert.equal(compareToBaseline(current, baseline, new Date("2026-01-15T00:00:00.000Z")).swellingSpike, true);
});
