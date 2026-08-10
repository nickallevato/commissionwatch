import type { AnomalyFlagType } from "@/types";

/**
 * Kept out of AnomalyCard.tsx so that file exports only its component. Mixing a
 * constant table in with a component breaks the React Refresh boundary, and a
 * re-export from the component file would break it just the same.
 */

/**
 * Keyed by the `anomaly_flag_type` enum — the single source of display names.
 * Sentence case, and deliberately descriptive rather than accusatory: a flag
 * marks something for a person to read, it does not assert wrongdoing.
 */
export const flagTypeLabels: Record<AnomalyFlagType, string> = {
  emergency_session: "Emergency session",
  closed_door_vote: "Closed-door vote",
  last_minute_agenda_change: "Last-minute agenda change",
  quorum_issue: "Quorum issue",
  unanimous_controversial: "Unanimous vote on a contested item",
  missing_minutes: "Minutes not published",
};
