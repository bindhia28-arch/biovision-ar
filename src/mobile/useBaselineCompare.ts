import { isSwellingSpike, swellingPercent } from "../core/geometry.js";
import type { BaselineStatus, ScanRecord } from "../core/types.js";

const BASELINE_MAX_AGE_DAYS = 30;

export function getBaselineStatus(baseline: ScanRecord | undefined, now = new Date()): BaselineStatus {
  if (!baseline) {
    return { isFresh: false, advancedAnalysisLocked: true };
  }
  const ageDays = Math.max(0, (now.getTime() - Date.parse(baseline.capturedAt)) / 86_400_000);
  const isFresh = Number.isFinite(ageDays) && ageDays <= BASELINE_MAX_AGE_DAYS;
  return { baselineId: baseline.id, ageDays, isFresh, advancedAnalysisLocked: !isFresh };
}

export interface BaselineComparison {
  volumeDifferentialCm3: number;
  swellingPercent: number;
  swellingSpike: boolean;
  baselineStatus: BaselineStatus;
}

export function compareToBaseline(current: ScanRecord, baseline: ScanRecord | undefined, now = new Date()): BaselineComparison {
  const baselineStatus = getBaselineStatus(baseline, now);
  if (!baseline) {
    throw new Error("A 30-day baseline is required for advanced analysis");
  }
  const swelling = swellingPercent(current.metrics.volumeCm3, baseline.metrics.volumeCm3);
  return {
    volumeDifferentialCm3: current.metrics.volumeCm3 - baseline.metrics.volumeCm3,
    swellingPercent: swelling,
    swellingSpike: isSwellingSpike(current.metrics.volumeCm3, baseline.metrics.volumeCm3),
    baselineStatus
  };
}
