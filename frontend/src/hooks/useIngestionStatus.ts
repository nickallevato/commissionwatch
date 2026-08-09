import { useQuery } from "@tanstack/react-query";
import { fetchOne } from "@/lib/api";

/**
 * When this site last fetched anything, from `ingestion_runs`.
 *
 * `/ingestion/status` is a one-off shape rather than the `{ data, total }`
 * envelope, so it goes through `fetchOne`.
 *
 * `lastSuccessfulSweepAt` is null when no sweep has ever landed work. That is a
 * real answer and the masthead prints it as one; it is never rounded up into a
 * number that sounds better.
 */
export interface IngestionStatus {
  lastSuccessfulSweepAt: string | null;
}

/** How long a sweep age may be believed before it is asked for again. */
const STALE_TIME_MS = 60_000;

export function useIngestionStatus() {
  return useQuery({
    queryKey: ["ingestion", "status"],
    queryFn: () => fetchOne<IngestionStatus>("/ingestion/status"),
    staleTime: STALE_TIME_MS,
  });
}

/**
 * `2026-08-09T04:12:00Z` seen from 2026-08-09T04:24:00Z -> `Last sweep 12 min ago`.
 *
 * Exported and pure so the wording is testable without a network, and so the
 * one branch that matters — no data — is impossible to reach by accident: every
 * input that is not a usable instant in the past returns the same honest
 * sentence rather than a fabricated age.
 */
export function formatSweepAge(
  lastSuccessfulSweepAt: string | null | undefined,
  now: Date = new Date(),
): string {
  if (lastSuccessfulSweepAt === null || lastSuccessfulSweepAt === undefined) {
    return "No sweep yet";
  }
  const swept = new Date(lastSuccessfulSweepAt);
  if (Number.isNaN(swept.getTime())) return "No sweep yet";

  const seconds = Math.floor((now.getTime() - swept.getTime()) / 1000);
  // A clock skew between the browser and the server must not print a sweep in
  // the future, which would read as a bug in the site rather than in the clock.
  if (seconds < 60) return "Last sweep just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Last sweep ${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Last sweep ${hours} hr${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(hours / 24);
  return `Last sweep ${days} day${days === 1 ? "" : "s"} ago`;
}
