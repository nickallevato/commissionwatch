import type { Knex } from "knex";
import { rosterCoverage } from "./roster-coverage";
import { totalTranscriptCoverage, transcriptCoverage } from "./transcript-coverage";

/**
 * This project's own numbers, published on the same terms it demands of others.
 *
 * `/status` reports whether ingestion is running. Nothing reported the *shape*
 * of the corpus, and the two numbers that would have exposed the real state
 * earliest — how much has been ingested but not published, and how long a
 * meeting waits — existed nowhere. `/api/data` said "1 meeting, 0 votes, 0
 * findings" for weeks before anyone framed that as the binding constraint on
 * every other feature.
 *
 * A watchdog that will not be measured by its own standard is asking for a
 * trust it has not earned. So this is public, and it is deliberately unflattering
 * where the truth is unflattering.
 *
 * ## Why aggregate counts of unpublished records are not a wall breach
 *
 * `services/publication.ts` refuses to let a stranger learn *which* records have
 * been ingested and withheld — a 404 rather than a 403, so the withheld set
 * cannot be enumerated. That is a rule about identifying a record. A count does
 * not identify one: "37 meetings ingested, 12 published" names nobody, points at
 * no id, and is the single most useful sentence a reader can have about how far
 * to trust the archive's completeness. Withholding it would protect nothing and
 * hide the project's biggest weakness.
 *
 * The line, stated so a later change does not cross it by accident: **counts and
 * durations, never identifiers, never titles, never names.** Nothing in this
 * module returns a row id or free text from an unpublished record.
 */

export interface CorpusMetrics {
  meetings_total: number;
  meetings_published: number;
  agenda_items: number;
  /** Artifacts whose text is in `artifact_texts` and therefore searchable. */
  documents_indexed: number;
  documents_total: number;
  votes: number;
  matters: number;
}

export interface ReviewMetrics {
  findings_total: number;
  findings_published: number;
  /** Held, which on this table means "not published" and includes rejected. */
  findings_held: number;
  claims_total: number;
  claims_approved: number;
  disputes_received: number;
  disputes_resolved: number;
}

export interface LatencyMetrics {
  /**
   * Days from a meeting's date to the moment an operator published it.
   *
   * Median rather than mean: one meeting published two years late would drag a
   * mean into meaninglessness, and the question a reader is asking is "how long
   * does this usually take".
   *
   * `null` when nothing has been published — which is a real answer and must not
   * render as 0, because "immediately" and "never" are opposite claims.
   */
  median_days_to_publish: number | null;
  /** Most recent publication, or null if there has never been one. */
  last_published_at: string | null;
}

/**
 * Signals about how well the record was *read*, as opposed to how much of it
 * there is.
 *
 * Both numbers here were computed by services that had no consumer. A quality
 * signal nothing reads is a quality signal nobody acts on, and the two most
 * useful ones in this system were sitting behind exported functions.
 */
export interface QualityMetrics {
  vote_events_total: number;
  vote_events_approved: number;
  /**
   * Officeholders the stored claims name who have no `members` row.
   *
   * This is the number that predicts the extractor's `not-an-official`
   * rejection rate: every unmatched name is a true claim the verifier will
   * throw away. It is a lower bound — it can only count names we already
   * extracted.
   */
  roster_unmatched: number;
  roster_seats_sourced: number;
  roster_seats_implied: number;
  /**
   * Whether any jurisdiction's roster can prove where it came from.
   *
   * `false` today and honestly so: `members` carries no source URL, no
   * fetched-at and no artifact sha, so a row naming a real commissioner is
   * indistinguishable from a row somebody typed. Publishing the `false` is the
   * point — it is the gap that gates the whole claims pipeline.
   */
  roster_sourced: boolean;
  /**
   * Transcript documents by state, over published meetings.
   *
   * Four numbers, and the fourth is the one that would otherwise flatter us.
   * `transcripts_unchecked` is a transcript document with no `transcript_status`
   * row — nobody has swept it — and omitting it would let a body with two
   * hundred unswept meetings render as fully covered. `absent` and `unavailable`
   * stay apart for the reason `transcript-coverage.ts` gives at length: one is
   * the custodian serving an empty caption file, the other is us failing to get
   * an answer, and collapsing them would publish our outage as the city's
   * silence.
   *
   * These are counted over *published* meetings only, unlike every other figure
   * in this module, because they come from `transcriptCoverage` and that query
   * is inside the publication wall. That is the right scope for a quality
   * signal about the record a reader can actually reach.
   */
  transcripts_published: number;
  transcripts_absent: number;
  transcripts_unavailable: number;
  transcripts_unchecked: number;
  /**
   * Places with at least one approved link, and places recorded at all.
   *
   * Two numbers because the map needs to tell three states apart and could only
   * tell two: "nothing near you", "we have located nothing anywhere" and "we
   * have located things but nobody has approved them" all render as an empty
   * result. The first is a statement about a neighbourhood; the other two are
   * statements about us, and saying the wrong one tells a reader their area is
   * quiet when the truth is that we have not looked.
   */
  places_public: number;
  places_total: number;
}

export interface Metrics {
  corpus: CorpusMetrics;
  quality: QualityMetrics;
  review: ReviewMetrics;
  latency: LatencyMetrics;
  generated_at: string;
}

/** `count()` returns a bigint, which arrives as a string. */
function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function countOf(db: Knex, table: string, build?: (q: Knex.QueryBuilder) => void): Promise<number> {
  const query = db(table);
  build?.(query);
  const row: unknown = await query.count({ n: "*" }).first();
  return typeof row === "object" && row !== null ? toCount((row as { n?: unknown }).n) : 0;
}

export async function collectMetrics(db: Knex, now: Date = new Date()): Promise<Metrics> {
  const [
    meetings_total,
    meetings_published,
    agenda_items,
    documents_indexed,
    documents_total,
    votes,
    matters,
    findings_total,
    findings_published,
    claims_total,
    claims_approved,
    disputes_received,
    disputes_resolved,
    vote_events_total,
    vote_events_approved,
    places_total,
    places_public,
  ] = await Promise.all([
    countOf(db, "meetings"),
    countOf(db, "meetings", (q) => q.whereNotNull("published_at")),
    countOf(db, "agenda_items"),
    countOf(db, "artifact_texts"),
    countOf(db, "artifacts"),
    countOf(db, "votes"),
    countOf(db, "matters"),
    countOf(db, "anomaly_flags"),
    countOf(db, "anomaly_flags", (q) => q.where("review_state", "published")),
    countOf(db, "minute_claims"),
    countOf(db, "minute_claims", (q) => q.where("status", "approved")),
    countOf(db, "record_disputes"),
    countOf(db, "record_disputes", (q) => q.whereIn("status", ["upheld", "declined"])),
    countOf(db, "vote_events"),
    countOf(db, "vote_events", (q) => q.where("status", "approved")),
    countOf(db, "places"),
    // A place is public when it has an approved, non-inferred link — the same
    // rule `wherePlaceLinkPublic` applies, kept here as an EXISTS rather than a
    // join so a place with three approved links counts once.
    countOf(db, "places", (q) =>
      q.whereExists(
        db("place_links")
          .whereRaw("place_links.place_id = places.id")
          .where("place_links.status", "approved")
          .whereNot("place_links.confidence", "inferred"),
      ),
    ),
  ]);

  // Reported per jurisdiction by the service and summed here, because a reader
  // of this page wants one number and an operator chasing a specific gap has
  // the per-jurisdiction breakdown available from the service directly.
  const coverage = await rosterCoverage(db, { asOf: now });

  // Summed from the rows `/api/transcripts/coverage` already serves rather than
  // aggregated again here. Two queries over the same tables would disagree the
  // first time either one's publication predicate changed, and the coverage page
  // is the one a reader drills into.
  const transcripts = totalTranscriptCoverage(await transcriptCoverage(db));

  // `percentile_cont` over the published set. Postgres computes it; doing it in
  // JavaScript would mean pulling every published meeting into memory to answer
  // a single number.
  const latencyRow: unknown = await db("meetings")
    .whereNotNull("published_at")
    .select(
      db.raw(
        "percentile_cont(0.5) within group (order by extract(epoch from (published_at - date::timestamp)) / 86400) as median_days",
      ),
      db.raw("max(published_at) as last_published_at"),
    )
    .first();

  const latency = typeof latencyRow === "object" && latencyRow !== null
    ? (latencyRow as { median_days?: unknown; last_published_at?: unknown })
    : {};

  // `percentile_cont` and `max` over an empty set both return SQL NULL, and
  // `Number(null)` is 0 — which `Number.isFinite` then happily accepts. That
  // path reported "published in 0 days" for a project that had never published
  // anything, which is the single worst thing this endpoint could say: "never"
  // and "instantly" are opposite claims and both render as the same number.
  // Caught by the test, which is why the null case has one.
  const medianRaw =
    latency.median_days === null || latency.median_days === undefined
      ? null
      : Number(latency.median_days);
  const lastPublished = latency.last_published_at;

  return {
    corpus: {
      meetings_total,
      meetings_published,
      agenda_items,
      documents_indexed,
      documents_total,
      votes,
      matters,
    },
    quality: {
      vote_events_total,
      vote_events_approved,
      roster_unmatched: coverage.reduce((total, row) => total + row.unmatched.length, 0),
      roster_seats_sourced: coverage.reduce((total, row) => total + row.seats_sourced, 0),
      roster_seats_implied: coverage.reduce((total, row) => total + row.seats_implied, 0),
      roster_sourced: coverage.some((row) => row.provenance !== "unsourced"),
      transcripts_published: transcripts.published,
      transcripts_absent: transcripts.absent,
      transcripts_unavailable: transcripts.unavailable,
      transcripts_unchecked: transcripts.unchecked,
      places_public,
      places_total,
    },
    review: {
      findings_total,
      findings_published,
      // Derived, not counted separately: the two must sum to the total, and two
      // independent counts taken microseconds apart can disagree.
      findings_held: findings_total - findings_published,
      claims_total,
      claims_approved,
      disputes_received,
      disputes_resolved,
    },
    latency: {
      median_days_to_publish:
        medianRaw !== null && Number.isFinite(medianRaw)
          ? Math.round(medianRaw * 10) / 10
          : null,
      last_published_at:
        lastPublished instanceof Date
          ? lastPublished.toISOString()
          : typeof lastPublished === "string"
            ? lastPublished
            : null,
    },
    generated_at: now.toISOString(),
  };
}
