import { useQueries, useQuery } from "@tanstack/react-query";
import { fetchJson, fetchOne } from "@/lib/api";
import type { PlaceDetail, PlacesNearResponse } from "@/types";

/**
 * The two reads behind `/map`.
 *
 * `fetchJson`, not `fetchList`: `/api/places/near` answers `{ data, radius,
 * limit }` and has no `total`, so the envelope check in `lib/api.ts` would
 * reject it. That is the check being right about the shape rather than a
 * contract to bend — see `PlacesNearResponse`.
 */

export interface NearQuery {
  lat: number;
  lon: number;
  /** Metres. The API refuses anything over 5,000 with a 400, never a clamp. */
  radius: number;
  /**
   * How many places to ask for.
   *
   * Deliberately smaller than the API's 50 default. Every result needs its
   * citation before it may be drawn, and `/near` does not carry one — so the
   * page makes one `/api/places/:id` request per result. That cost is real and
   * it is stated here rather than hidden behind a default: 25 rows is 26
   * requests. If this ever needs to be larger, the fix is the near route
   * carrying its links, not a bigger number here.
   */
  limit?: number;
}

/**
 * `GET /api/places/near`.
 *
 * `query` is nullable and the request is disabled until a reader has given a
 * coordinate. A page that fired this on mount would have to invent a centre,
 * and the only honest centres are "wherever the reader is" — which is a
 * geolocation prompt nobody asked for — and "the middle of Bozeman", which
 * would answer a question the reader did not ask and looks identical to an
 * answer they did.
 */
export function usePlacesNear(query: NearQuery | null) {
  return useQuery({
    queryKey: ["places", "near", query],
    queryFn: () => {
      // Non-null inside the queryFn only because `enabled` gates it; react-query
      // does not narrow the closure for us and a `!` here would be the assertion
      // this project does not allow.
      if (query === null) throw new Error("usePlacesNear ran with no coordinate");
      const params = new URLSearchParams({
        lat: String(query.lat),
        lon: String(query.lon),
        radius: String(query.radius),
        limit: String(query.limit ?? 25),
      });
      return fetchJson<PlacesNearResponse>(`/places/near?${params.toString()}`);
    },
    enabled: query !== null,
  });
}

/**
 * `GET /api/places/:id` for a list of places, in one hook.
 *
 * One request per place, which is a real cost and is the reason `NearQuery`
 * asks for fewer rows than the API would give. It is not avoidable from here:
 * `/near` carries the coordinate and the precision but **not the links**, and a
 * place may not be drawn until its citation is in hand — a pin is a claim about
 * where a decision happened, and an unsourced one is exactly what "no unsourced
 * claim reaches the public site" forbids. Fetching the whole list first and
 * discarding what turns out to be uncitable would put uncited marks on the
 * figure for as long as the details were in flight.
 *
 * `useQueries` rather than a component-level `useQuery` per row for the same
 * reason: the page needs to know which places are citable *before* it draws any
 * of them, and a hook inside a row it has already rendered is too late.
 *
 * 404 covers both "no such place" and "every link it has is held, inferred, or
 * points at an unpublished record", deliberately and for the reason `findPlace`
 * gives: telling those apart would let anyone enumerate the addresses this
 * project has geocoded out of records nobody has published. Either way the
 * place does not appear.
 */
export function usePlaceDetails(ids: string[]) {
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: ["places", id],
      queryFn: () => fetchOne<PlaceDetail>(`/places/${id}`),
    })),
  });
}
