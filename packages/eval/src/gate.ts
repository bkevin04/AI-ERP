import type { AggregateScores } from "./score.js";

export interface GateThresholds {
  minAutoPrecision: number;
  minCases: number;
}

export const DEFAULT_GATE: GateThresholds = { minAutoPrecision: 0.99, minCases: 50 };

export interface GateResult {
  green: boolean;
  reasons: string[];
  autoPrecision: number | null;
  nCases: number;
}

/**
 * Autonomy level 2 is allowed only when the harness proves it: enough cases, near-perfect
 * precision on what would have auto-committed, and zero critical errors anywhere.
 */
export function computeGate(agg: AggregateScores, t: GateThresholds = DEFAULT_GATE): GateResult {
  const reasons: string[] = [];
  if (agg.n < t.minCases) reasons.push(`only ${agg.n} cases, need ${t.minCases}`);
  if (agg.autoEligiblePrecision === null) reasons.push("no auto-eligible cases yet");
  else if (agg.autoEligiblePrecision < t.minAutoPrecision) reasons.push(`auto-eligible precision ${agg.autoEligiblePrecision.toFixed(3)} below ${t.minAutoPrecision}`);
  if (agg.criticalErrors > 0) reasons.push(`${agg.criticalErrors} critical error(s) in auto-eligible or reviewed cases`);
  return { green: reasons.length === 0, reasons, autoPrecision: agg.autoEligiblePrecision, nCases: agg.n };
}
