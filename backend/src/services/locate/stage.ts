import type { Knex } from "knex";
import { UnsupportedDocumentError } from "../ingestion/pdf-text";
import { extractDocumentText } from "../ingestion/document-text";
import { BlockedError, type IngestionQueue } from "../ingestion/queue";
import type { LocateContext, StageResult } from "../ingestion/worker";
import { GeocoderError, type Geocoder } from "./census";
import { findAgendaArtifact, locateAgendaPlaces } from "./run";

/**
 * Locating an agenda as a queue stage.
 *
 * The `extract` and `govern` precedent, for their reasons. Work that calls a
 * third party and writes rows needs an `ingestion_jobs` row to own it: without
 * one a deploy mid-run loses it silently, there is no backoff against a service
 * that is rate-limiting us, and "how much of the corpus has been located" has no
 * answer. It is emphatically not a loop in a route.
 *
 * It is a post-`fetch` stage. Its target carries a content address and no URL,
 * and the bytes arrive already resolved — so the only host this handler can
 * reach is the geocoder it was constructed with, and the sweep's fetch politeness
 * is not something this stage can route around.
 */

/**
 * How many locate jobs may be in flight at once.
 *
 * One. The Census geocoder is a free public service we are a guest on, it
 * publishes rate limits, and a batch of eight workers each pausing a second
 * between requests is eight requests a second — the pause looks like politeness
 * and does nothing. Serial, with `GEOCODER_MIN_INTERVAL_MS` between calls, is
 * the whole of the rate control, and both halves are needed.
 *
 * It is also the batch size of the locate worker, so raising it is one edit here
 * and a decision about somebody else's server.
 */
export const LOCATE_CONCURRENCY = 1;

export interface LocateHandlerDeps {
  geocoder: Geocoder;
}

/** Raised by the enqueuer when there is nothing to locate. Carries a status. */
export class LocationUnavailable extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "LocationUnavailable";
  }
}

/**
 * The `locate` stage handler.
 *
 * Failure classification, as `createExtractHandler` does it:
 *
 *  - A document that is neither PDF nor HTML, or one with no text layer, is
 *    `blocked`. Retrying does not give a scan a text layer, and burning five
 *    attempts to discover that would hide the reason behind "attempts
 *    exhausted".
 *  - A geocoder failure is **thrown**, so the queue retries with backoff. A
 *    federal endpoint being down for ten minutes is the case retrying does fix,
 *    and turning it into "no places found" would quietly record an agenda as
 *    having no locations in it.
 */
export function createLocateHandler(
  deps: LocateHandlerDeps,
): (ctx: LocateContext) => Promise<StageResult> {
  return async (ctx) => {
    let text;
    try {
      // Bozeman's agendas are HTML and Gallatin's are PDFs, and both are
      // agendas — the same call `handlers.ts` makes at parse time, joined the
      // same way, because the offsets this stage stores have to index into the
      // same projection `artifact_texts` holds.
      text = await extractDocumentText(ctx.content, ctx.artifact.contentType);
    } catch (error) {
      if (error instanceof UnsupportedDocumentError) {
        throw new BlockedError(error.message);
      }
      throw error;
    }

    const documentText = text.lines.join("\n");
    if (documentText.trim() === "") {
      throw new BlockedError(
        "The stored agenda carries no extractable text layer, so no address could be cited to it.",
      );
    }

    let tally;
    try {
      tally = await locateAgendaPlaces(ctx.db, deps.geocoder, {
        meetingId: ctx.target.meetingId,
        artifactSha256: ctx.artifact.sha256,
        documentText,
      });
    } catch (error) {
      if (error instanceof GeocoderError) {
        // Rethrown as a plain Error so the queue retries it with backoff rather
        // than holding it: the geocoder being unreachable is temporary, and a
        // blocked job needs a human to clear it.
        throw new Error(error.message);
      }
      throw error;
    }

    return {
      counts: {
        locate_items_read: tally.items,
        locate_addresses_found: tally.mentions,
        locate_uncited: tally.uncited,
        locate_unresolved: tally.unresolved,
        places_recorded: tally.places,
        place_links_held: tally.links,
      },
    };
  };
}

export interface EnqueuedLocation {
  job_id: string;
  /** The `ingestion_runs` row the job belongs to — the work ledger. */
  run_id: string;
  meeting_id: string;
  artifact_sha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The locate job already queued or running for this meeting, if there is one. */
export async function queuedLocation(db: Knex, meetingId: string): Promise<string | null> {
  const row: unknown = await db("ingestion_jobs")
    .where("stage", "locate")
    .whereIn("status", ["pending", "running"])
    .whereRaw("target ->> 'meetingId' = ?", [meetingId])
    .first("id");
  if (!isRecord(row) || typeof row.id !== "string") return null;
  return row.id;
}

/**
 * Queue this meeting's agenda for location.
 *
 * A fresh `ingestion_runs` row per request, for `enqueueExtraction`'s reason:
 * the original run is a record of what happened on a date, and reopening it to
 * say something else about that date is the mutation this project refuses
 * everywhere else. The source comes from the parse job that captured the bytes,
 * because `ingestion_runs.source_id` is NOT NULL and the queue already knows the
 * answer without a second lookup that could disagree.
 */
export async function enqueueLocation(
  db: Knex,
  queue: IngestionQueue,
  meetingId: string,
): Promise<EnqueuedLocation> {
  const artifact = await findAgendaArtifact(db, meetingId);
  if (artifact === null) {
    throw new LocationUnavailable(
      "No agenda document has been parsed for this meeting, so there is nothing to cite an " +
        "address to. Locations are read from the agenda the items came out of.",
      404,
    );
  }

  const queued = await queuedLocation(db, meetingId);
  if (queued !== null) {
    throw new LocationUnavailable(
      `A location pass over this meeting is already queued (job ${queued}).`,
      409,
    );
  }

  const inserted: unknown = await db("ingestion_runs")
    .insert({
      source_id: artifact.sourceId,
      status: "running",
      counts: JSON.stringify({ locate_queued: 1 }),
    })
    .returning("id");
  const row: unknown = Array.isArray(inserted) ? inserted[0] : undefined;
  if (!isRecord(row) || typeof row.id !== "string") {
    throw new LocationUnavailable("Could not open a run for the location pass", 500);
  }

  const jobId = await queue.enqueue("locate", { sha256: artifact.sha256, meetingId }, row.id);

  return {
    job_id: jobId,
    run_id: row.id,
    meeting_id: meetingId,
    artifact_sha256: artifact.sha256,
  };
}
