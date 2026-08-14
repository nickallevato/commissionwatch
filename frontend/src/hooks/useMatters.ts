import { useQuery } from "@tanstack/react-query";
import { fetchList, fetchOne } from "@/lib/api";
import type { Matter, MatterDetail, MatterState } from "@/types";

export interface MattersFilter {
  jurisdiction_id?: string;
  state?: MatterState;
}

function buildQuery(filters: MattersFilter): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

/**
 * `GET /api/matters` — the subjects of decision, not the meetings.
 *
 * The list is filtered server-side rather than here. `state` is derived by the
 * API at read time from the appearances and any recorded vote, so a filter
 * applied in the browser would be filtering on a value the browser cannot
 * recompute — and would quietly disagree with the API the moment the derivation
 * changed.
 */
export function useMatters(filters: MattersFilter = {}) {
  return useQuery({
    queryKey: ["matters", filters],
    queryFn: async () => {
      const res = await fetchList<Matter>(`/matters${buildQuery(filters)}`);
      return res.data;
    },
  });
}

/**
 * `GET /api/matters/:id`, which embeds the appearance timeline.
 *
 * A matter with no published appearance answers 404, exactly as an unpublished
 * meeting does, and for the same reason: distinguishing "no such matter" from
 * "withheld" would let anyone enumerate what has been ingested and not
 * published. The page treats both as not found and says so.
 */
export function useMatter(id: string) {
  return useQuery({
    queryKey: ["matters", id],
    queryFn: () => fetchOne<MatterDetail>(`/matters/${id}`),
    enabled: !!id,
  });
}
