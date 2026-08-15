import { useQuery } from "@tanstack/react-query";
import { fetchOne } from "@/lib/api";
import type { PublicClaims } from "@/types";

/**
 * `GET /api/meetings/:id/claims` — what a reader may see from one meeting.
 *
 * A sub-resource of the meeting and deliberately not a route of its own. A
 * claim is addressable at `#claim-{id}` and is never its own page: a page whose
 * entire content is one sentence about one named person is an accusation, and
 * the same sentence inside the record it came from is a record. That is why
 * there is no `useClaim(id)` beside this and why one should not be added.
 *
 * The response carries three things and the page must render all three. The
 * claims are the obvious one; the tombstones and the withheld count are the two
 * a page would drop by accident, and dropping either is the failure mode — a
 * withdrawal a reader arrived from, and the fact that something is being held
 * back, are both statements the reader is owed.
 *
 * A bare object, not a `{ data, total }` envelope — see the endpoint table in
 * `lib/api.ts`.
 */
export function useMeetingClaims(meetingId: string) {
  return useQuery({
    queryKey: ["meetings", meetingId, "claims"],
    queryFn: () => fetchOne<PublicClaims>(`/meetings/${meetingId}/claims`),
    enabled: Boolean(meetingId),
  });
}
