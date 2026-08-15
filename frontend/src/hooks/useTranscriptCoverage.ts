import { useQuery } from "@tanstack/react-query";
import { fetchOne } from "@/lib/api";
import type { TranscriptCoverageResponse, TranscriptCoverageRow } from "@/types";

/**
 * `GET /api/transcripts/coverage` — how much of each body's archive we hold a
 * transcript for, per calendar year.
 *
 * Its own endpoint rather than a field on `/api/metrics`, because that is where
 * the backend actually put it: `services/metrics.ts` returns counts and
 * durations for the corpus as a whole and knows nothing about
 * `transcript_status`. Adding it there would be a backend change, and this is
 * the read that already exists.
 *
 * A bare `{ coverage }` object, not the `{ data, total }` envelope every
 * collection route uses — see `backend/src/routes/transcripts.ts`. Unwrapped
 * here so no caller has to remember which of the two shapes this one is.
 */
export function useTranscriptCoverage() {
  return useQuery({
    queryKey: ["transcripts", "coverage"],
    queryFn: async (): Promise<TranscriptCoverageRow[]> => {
      const res = await fetchOne<TranscriptCoverageResponse>(
        "/transcripts/coverage",
      );
      return res.coverage;
    },
  });
}
