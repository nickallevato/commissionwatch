import { useQuery } from "@tanstack/react-query";
import { fetchList } from "@/lib/api";
import type { Jurisdiction } from "@/types";

/**
 * `/jurisdictions` returns the `{ data, total }` envelope like every other
 * collection endpoint, so this unwraps it rather than typing a bare array —
 * a hook that types one as `T[]` hands components an object and every `.map`
 * over it throws.
 */
export function useJurisdictions() {
  return useQuery({
    queryKey: ["jurisdictions"],
    queryFn: async () => {
      const res = await fetchList<Jurisdiction>("/jurisdictions");
      return res.data;
    },
  });
}
