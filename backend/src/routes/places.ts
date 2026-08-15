import { Router, type Request } from "express";
import db from "../config/database";
import {
  DEFAULT_PLACE_RESULTS,
  MAX_PLACE_RESULTS,
  PlaceQueryError,
  findPlace,
  parseCoordinate,
  parseRadius,
  placesNear,
} from "../services/places";

/**
 * `GET /api/places/near` and `GET /api/places/:id` — the read half of the map.
 *
 * **There are no write routes here, and none may be added.** Places are written
 * by extraction and by operator action, and neither of those is a request from
 * the public internet. An unauthenticated write endpoint on this table would let
 * anyone attach a coordinate to a published meeting — the same defect that once
 * left `POST /api/anomalies` open, except that the thing being planted is an
 * address on a map. When the operator console needs to edit a place it gets a
 * route under `/api/admin`, behind the session the rest of that console uses.
 *
 * Everything served here is filtered by `wherePlaceLinkPublic` inside
 * `services/places.ts`. This file bounds the request and formats the answer; it
 * does not re-derive the wall.
 *
 * Mounted by the orchestrator: `app.use("/api/places", placesRouter)`.
 */

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badRequest(message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = 400;
  return err;
}

/**
 * Express parses `?lat=1&lat=2` into an array. Picking one would be a guess
 * about which the caller meant, and a guess about a coordinate is a guess about
 * which street a reader is standing on.
 */
function single(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  throw badRequest(`${name} may be given at most once.`);
}

interface NearQuery {
  lat?: unknown;
  lon?: unknown;
  radius?: unknown;
  jurisdiction_id?: unknown;
  limit?: unknown;
}

/**
 * Places within a radius of a point.
 *
 * A malformed coordinate is a 400, never a default. `Number("")` is 0, so a
 * missing `lat` silently defaulted would answer with whatever is within 500
 * metres of the Gulf of Guinea — an empty result that reads exactly like "there
 * is nothing near you", which is the confident wrong answer this API must never
 * give.
 *
 * The radius is bounded at `MAX_RADIUS_METRES` rather than clamped, for the same
 * reason. A caller who asked for 50 km and got 5 km would believe the answer
 * covered 50.
 */
router.get("/near", async (req: Request<unknown, unknown, unknown, NearQuery>, res, next) => {
  try {
    const { lat, lon } = parseCoordinate(
      single(req.query.lat, "lat"),
      single(req.query.lon, "lon"),
    );
    const metres = parseRadius(single(req.query.radius, "radius"));

    const jurisdiction = single(req.query.jurisdiction_id, "jurisdiction_id");
    if (jurisdiction !== undefined && !UUID_RE.test(jurisdiction)) {
      throw badRequest("jurisdiction_id must be a UUID.");
    }

    const rawLimit = single(req.query.limit, "limit");
    const limit = Math.min(
      Math.max(parseInt(rawLimit ?? String(DEFAULT_PLACE_RESULTS), 10) || DEFAULT_PLACE_RESULTS, 1),
      MAX_PLACE_RESULTS,
    );

    const data = await placesNear(db, {
      lat,
      lon,
      metres,
      jurisdictionId: jurisdiction,
      limit,
    });

    // The radius is echoed because the caller may have omitted it, and a client
    // drawing a circle needs to know which one was actually applied.
    res.json({ data, radius: metres, limit });
  } catch (err) {
    if (err instanceof PlaceQueryError) {
      next(badRequest(err.message));
      return;
    }
    next(err);
  }
});

/**
 * One place and its public links.
 *
 * 404, never 403, when every link is held, inferred, or points at an
 * unpublished record — see `findPlace`. Distinguishing the two would let anyone
 * enumerate the addresses this project has geocoded out of records nobody has
 * published.
 */
router.get("/:id", async (req: Request<{ id: string }>, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) throw badRequest("Invalid place ID format");

    const place = await findPlace(db, id);
    if (!place) {
      res.status(404).json({ error: "Place not found", statusCode: 404 });
      return;
    }

    res.json(place);
  } catch (err) {
    next(err);
  }
});

export default router;
