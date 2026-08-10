import type { AnomalySeverity } from "@/types";

/**
 * The severity vocabulary lives here rather than in AnomalyBadge.tsx so that
 * file exports nothing but components. A module that mixes components with
 * plain constants breaks the React Refresh boundary, and an edit to either one
 * forces a full reload instead of a hot swap.
 */

/**
 * The four `anomaly_severity` enum members projected onto the 1–5 scale the
 * editorial palette is built around: 4–5 accent red, 3 amber, 1–2 grey.
 * The numeral is the primary signal; colour only reinforces it, because colour
 * alone is not an accessible way to encode severity.
 */
export const severityRank: Record<AnomalySeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
};

/** Sentence-case display names for the severity enum. */
export const severityLabels: Record<AnomalySeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** Descending — highest first. Filter menus and max-severity lookups use this. */
export const severityOrder: AnomalySeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
];
