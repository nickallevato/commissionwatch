import { useQuery } from "@tanstack/react-query";
import { fetchOne } from "@/lib/api";
import type { Metrics } from "@/types";

/**
 * `GET /api/metrics` — a bare object, not a `{ data, total }` envelope.
 *
 * No `staleTime` override: the endpoint sets its own `Cache-Control`, and a
 * second opinion about freshness held in the browser is how two surfaces start
 * disagreeing about the same number.
 */
export function useMetrics() {
  return useQuery({
    queryKey: ["metrics"],
    queryFn: () => fetchOne<Metrics>("/metrics"),
  });
}
