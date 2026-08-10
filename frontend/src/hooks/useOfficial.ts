import { useQuery } from "@tanstack/react-query";
import { fetchOne } from "@/lib/api";
import type { FinanceCoverage, OfficialProfile } from "@/types";

/**
 * One official's profile. A bare object, not a `{ data, total }` envelope —
 * see the endpoint table in `lib/api.ts`.
 */
export function useOfficial(id: string | undefined) {
  return useQuery({
    queryKey: ["officials", id],
    queryFn: () => fetchOne<OfficialProfile>(`/officials/${id}`),
    enabled: Boolean(id),
  });
}

/**
 * What campaign finance this site has consulted, independent of any official.
 *
 * Separate from the profile on purpose: the caveat has to be sayable when
 * there is no profile to attach it to, which is the case where it matters most.
 */
export function useFinanceCoverage() {
  return useQuery({
    queryKey: ["officials", "finance-coverage"],
    queryFn: () => fetchOne<FinanceCoverage>("/officials/finance-coverage"),
  });
}
