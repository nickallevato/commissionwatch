import type { Knex } from "knex";
import { whereEventPublic } from "../events";
import { EVENT_SEVERITIES, type EventSeverity } from "../events/emit";
import { whereClaimPublic } from "../publication";
import { renderApprovedClaim } from "../review/claims";
import { eventUrn, withdrawnTitle, type FeedCitation, type FeedEntry } from "./atom";

/**
 * `events` → feed entries.
 *
 * The wall is not re-derived here. `whereEventPublic` is the consumer half of
 * the event spine and it is imported, not retyped — an event exists only for an
 * object that was already public when it was written, and the two things that
 * guarantee does not cover (`ops` rows and revoked rows) are exactly what that
 * helper removes. `feeds.test.ts` asserts the `ops` half on this consumer,
 * because "the emitter is careful" is not a property a feed can be built on.
 *
 * `listPublicEvents` was the obvious thing to call and it does not fit: it
 * selects no `payload` (a retraction's reason lives there) and it filters on
 * `subject_kind` rather than `event_type` or `severity`, which are the two
 * filters §2 of the delivery spec puts in the URL. So the query is built here
 * over the same helper rather than by widening a function another agent owns.
 *
 * **No sentence about a named person is composed in this file.** The claim
 * entry's headline comes from `renderApprovedClaim` in `services/review/claims.ts`
 * — the same frozen `ACTION_LABEL` template fill the claim card publishes, with
 * the same pin — imported rather than reimplemented, because a second renderer
 * is a second thing that can drift and the thing it would drift about is a
 * sentence naming a living person. When the pin does not hold, the entry is
 * **dropped**: the feed does not fall back to `rendered_text` and does not
 * invent a title, for exactly the reason `renderApprovedClaim` refuses to.
 *
 * Everything else is a template fill over stored columns — a commission name, a
 * date, a flag type, a document title.
 */

/** Ordered weakest to strongest, so `severity=medium` means "medium or worse". */
const SEVERITY_RANK: ReadonlyMap<string, number> = new Map(
  EVENT_SEVERITIES.map((name, index) => [name, index]),
);

/** Every severity at or above `min`. Used as an `IN` list, not a comparison. */
export function severitiesAtLeast(min: EventSeverity): EventSeverity[] {
  const floor = SEVERITY_RANK.get(min) ?? 0;
  return EVENT_SEVERITIES.filter((name) => (SEVERITY_RANK.get(name) ?? 0) >= floor);
}

export interface EventFeedFilters {
  jurisdiction_id?: string | null;
  event_type?: string | null;
  min_severity?: EventSeverity | null;
  limit: number;
}

interface FeedEventRow {
  id: string;
  event_type: string;
  subject_kind: string;
  subject_id: string;
  jurisdiction_id: string | null;
  severity: string | null;
  occurred_at: Date;
  payload: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** `pg` hands back jsonb already parsed; a text column would not. Tolerate both. */
function payloadOf(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function origin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** `YYYY-MM-DD` out of a `date` column, which `pg` may give as either. */
function dateText(value: Date | string | null): string {
  if (value === null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

/* ------------------------------------------------------------------------- *
 * The query
 * ------------------------------------------------------------------------- */

function feedEventsQuery(db: Knex, filters: EventFeedFilters): Knex.QueryBuilder {
  const query = db("events")
    .orderBy([{ column: "occurred_at", order: "desc" }, { column: "id", order: "desc" }])
    .limit(filters.limit)
    .select(
      "id",
      "event_type",
      "subject_kind",
      "subject_id",
      "jurisdiction_id",
      "severity",
      "occurred_at",
      "payload",
    );

  if (filters.jurisdiction_id) query.where("events.jurisdiction_id", filters.jurisdiction_id);
  if (filters.event_type) query.where("events.event_type", filters.event_type);
  if (filters.min_severity) {
    // Drops rows whose severity is NULL, which is correct and worth stating: an
    // event that never claimed a severity has not met a floor, and treating
    // "unset" as "info" would put uncategorised rows in a feed a reader
    // deliberately narrowed.
    query.whereIn("events.severity", severitiesAtLeast(filters.min_severity));
  }

  return whereEventPublic(query);
}

/* ------------------------------------------------------------------------- *
 * Hydration — one query per subject kind, never one per row
 * ------------------------------------------------------------------------- */

/**
 * Exported for the near feed in `query.ts`, which needs the same four columns to
 * label an entry. A second copy of this join would be a second answer to "what
 * do we call this meeting", and the two would drift.
 */
export interface MeetingContext {
  meeting_id: string;
  meeting_date: string;
  commission_name: string;
  jurisdiction_name: string;
}

interface SourceRef {
  label: string;
  url: string;
  sha256: string | null;
}

export async function meetingContexts(
  db: Knex,
  ids: string[],
): Promise<Map<string, MeetingContext>> {
  if (ids.length === 0) return new Map();
  const rows = await db("meetings as m")
    .join("commissions as c", "c.id", "m.commission_id")
    .join("jurisdictions as j", "j.id", "c.jurisdiction_id")
    .whereIn("m.id", ids)
    .select<Array<Record<string, unknown>>>(
      "m.id as meeting_id",
      db.raw("m.date::text as meeting_date"),
      "c.name as commission_name",
      "j.name as jurisdiction_name",
    );

  return new Map(
    rows.map((row) => [
      textOf(row.meeting_id),
      {
        meeting_id: textOf(row.meeting_id),
        meeting_date: textOf(row.meeting_date),
        commission_name: textOf(row.commission_name),
        jurisdiction_name: textOf(row.jurisdiction_name),
      },
    ]),
  );
}

/**
 * The document we read a meeting from, and the artifact behind it.
 *
 * `meeting_documents.url` is NOT NULL (migration 005), so a document always has
 * *somewhere* to point; `document_versions → artifacts` supplies the sha256
 * when the bytes were actually stored. The upstream URL is used as the link
 * rather than `/source/{sha}`, which the published-claim spec designs but which
 * does not exist yet — a citation pointing at a route we have not built is a
 * dead link in a reader's inbox, which is worse than "where we got it". When
 * the artifact viewer ships, this is the function that changes, once.
 */
async function documentSources(
  db: Knex,
  documentIds: string[],
  meetingIds: string[],
): Promise<{ byDocument: Map<string, SourceRef>; byMeeting: Map<string, SourceRef> }> {
  const byDocument = new Map<string, SourceRef>();
  const byMeeting = new Map<string, SourceRef>();
  if (documentIds.length === 0 && meetingIds.length === 0) return { byDocument, byMeeting };

  const rows = await db("meeting_documents as md")
    .leftJoin("document_versions as dv", "dv.meeting_document_id", "md.id")
    .leftJoin("artifacts as a", "a.id", "dv.artifact_id")
    .where((builder) => {
      if (documentIds.length > 0) builder.orWhereIn("md.id", documentIds);
      if (meetingIds.length > 0) builder.orWhereIn("md.meeting_id", meetingIds);
    })
    // Newest version first, so the sha a reader is handed is the bytes we hold
    // now; oldest document first, so a meeting's citation is stable rather than
    // changing every time another attachment is scraped.
    .orderBy([
      { column: "md.created_at", order: "asc" },
      { column: "md.id", order: "asc" },
      { column: "dv.version_no", order: "desc" },
    ])
    .select<Array<Record<string, unknown>>>(
      "md.id as document_id",
      "md.meeting_id as meeting_id",
      "md.title as title",
      "md.document_type as document_type",
      "md.url as url",
      "a.sha256 as sha256",
    );

  for (const row of rows) {
    const ref: SourceRef = {
      label: `${textOf(row.title)} (${textOf(row.document_type)})`,
      url: textOf(row.url),
      sha256: typeof row.sha256 === "string" ? row.sha256 : null,
    };
    const documentId = textOf(row.document_id);
    const meetingId = textOf(row.meeting_id);
    if (!byDocument.has(documentId)) byDocument.set(documentId, ref);
    if (!byMeeting.has(meetingId)) byMeeting.set(meetingId, ref);
  }

  return { byDocument, byMeeting };
}

interface FindingContext {
  id: string;
  description: string;
  flag_type: string;
  severity: string;
  meeting_id: string | null;
  source_url: string | null;
  sha256: string | null;
}

async function findingContexts(db: Knex, ids: string[]): Promise<Map<string, FindingContext>> {
  if (ids.length === 0) return new Map();
  const rows = await db("anomaly_flags as af")
    .leftJoin("artifacts as a", "a.id", "af.artifact_id")
    .whereIn("af.id", ids)
    .select<Array<Record<string, unknown>>>(
      "af.id as id",
      "af.description as description",
      "af.flag_type as flag_type",
      "af.severity as severity",
      "af.meeting_id as meeting_id",
      "a.source_url as source_url",
      "a.sha256 as sha256",
    );

  return new Map(
    rows.map((row) => [
      textOf(row.id),
      {
        id: textOf(row.id),
        description: textOf(row.description),
        flag_type: textOf(row.flag_type),
        severity: textOf(row.severity),
        meeting_id: typeof row.meeting_id === "string" ? row.meeting_id : null,
        source_url: typeof row.source_url === "string" ? row.source_url : null,
        sha256: typeof row.sha256 === "string" ? row.sha256 : null,
      },
    ]),
  );
}

interface ClaimContext {
  id: string;
  meeting_id: string;
  /** The pinned sentence, straight out of `renderApprovedClaim`. */
  text: string;
  quote: string;
  artifact_sha256: string;
  quote_offset: number;
  source_url: string | null;
}

/**
 * Public claims only, and only the ones whose pin still holds.
 *
 * Two walls, not one, and the second is why this cannot lean on the event
 * alone. `whereClaimPublic` (migration 087's exact predicate: approved, not
 * retracted, meeting published) is applied here because
 * `services/events/emit.ts` checks `status = 'approved'` and a published
 * meeting but **not** `retracted_at IS NULL` — so a claim retracted after its
 * event was written still satisfies the emitter's check. The event stays in the
 * table; this query is what stops the sentence being re-served.
 *
 * A claim whose pin broke is simply absent from the map, so the caller drops
 * the entry. The public meeting page counts those and says "awaiting
 * re-review"; a feed has nowhere to put a count, and silence is the correct
 * behaviour when the alternative is publishing unpinned text.
 */
async function claimContexts(db: Knex, ids: string[]): Promise<Map<string, ClaimContext>> {
  if (ids.length === 0) return new Map();
  const query = db("minute_claims")
    // Joined on the content address, not on an FK, because migration 072
    // deliberately stores a sha rather than a reference: a reissued document is
    // different bytes and the claim must keep pointing at what it was read from.
    .leftJoin("artifacts as a", "a.sha256", "minute_claims.artifact_sha256")
    .whereIn("minute_claims.id", ids)
    .select<Array<Record<string, unknown>>>("minute_claims.*", "a.source_url as source_url");
  const rows = await whereClaimPublic(db, query);

  const contexts = new Map<string, ClaimContext>();
  for (const row of rows) {
    const render = renderApprovedClaim({
      subject_name: row.subject_name,
      action: row.action,
      matter: row.matter,
      rendered_text: row.rendered_text,
      render_sha256: row.render_sha256,
      render_version: row.render_version,
    });
    if (render.state !== "renderable") continue;

    contexts.set(textOf(row.id), {
      id: textOf(row.id),
      meeting_id: textOf(row.meeting_id),
      text: render.text,
      quote: textOf(row.quote),
      artifact_sha256: textOf(row.artifact_sha256),
      quote_offset: Number(row.quote_offset) || 0,
      source_url: typeof row.source_url === "string" ? row.source_url : null,
    });
  }
  return contexts;
}

async function documentMeetings(db: Knex, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db("meeting_documents")
    .whereIn("id", ids)
    .select<Array<Record<string, unknown>>>("id", "meeting_id");
  return new Map(rows.map((row) => [textOf(row.id), textOf(row.meeting_id)]));
}

/* ------------------------------------------------------------------------- *
 * Assembly
 * ------------------------------------------------------------------------- */

function meetingLabel(context: MeetingContext | undefined): string {
  if (context === undefined) return "the record";
  return `${context.commission_name}, ${dateText(context.meeting_date)}`;
}

function recordCitation(homeUrl: string, path: string, label: string): FeedCitation {
  return { label, url: `${homeUrl}${path}`, sha256: null };
}

/**
 * A retraction is built from the event alone.
 *
 * That is not laziness — it is required. The subject is, by construction, no
 * longer public (`emitEvent` refuses a `*.retracted` event for a subject that
 * still is), so re-reading its row to decorate the entry would be publishing
 * the withdrawn record a second time in the act of withdrawing it. The reason
 * comes from the event payload, which an operator typed, and the entry points
 * at the corrections log — the append-only public history where the withdrawal
 * lives.
 */
function retractionEntry(row: FeedEventRow, homeUrl: string): FeedEntry {
  const reason = textOf(payloadOf(row.payload).reason);
  return {
    urn: eventUrn(row.id),
    title: withdrawnTitle(`a published ${row.subject_kind}`),
    summary:
      reason.length === 0
        ? "This record has been withdrawn. See the corrections log."
        : `This record has been withdrawn. Reason given: ${reason}`,
    url: `${homeUrl}/corrections`,
    updated: row.occurred_at,
    retraction: true,
    citation: recordCitation(homeUrl, "/corrections", "The public corrections log"),
  };
}

/**
 * Turns public events into feed entries, newest first.
 *
 * An event whose subject cannot be hydrated is dropped rather than rendered
 * without its citation. That happens when a row was deleted out from under the
 * announcement — migration 083 keeps the event forever precisely so a deleted
 * meeting does not un-announce itself — and an entry with a title and no source
 * is the one thing this feed must never emit.
 */
export async function collectEventEntries(
  db: Knex,
  baseUrl: string,
  filters: EventFeedFilters,
): Promise<FeedEntry[]> {
  const homeUrl = origin(baseUrl);
  const rows = (await feedEventsQuery(db, filters)) as FeedEventRow[];

  // A retraction is deliberately excluded from hydration: its subject is no
  // longer public, so there is nothing we are still allowed to read about it.
  const live = rows.filter((row) => !row.event_type.endsWith(".retracted"));

  const idsOf = (kind: string): string[] =>
    live.filter((row) => row.subject_kind === kind).map((row) => row.subject_id);

  const meetingEventIds = idsOf("meeting");
  const findingIds = idsOf("finding");
  const claimIds = idsOf("claim");
  const documentIds = idsOf("document");

  const findings = await findingContexts(db, findingIds);
  const claims = await claimContexts(db, claimIds);
  const documentMeetingIds = await documentMeetings(db, documentIds);

  const contextMeetingIds = [
    ...new Set([
      ...meetingEventIds,
      ...claimIds.map((id) => claims.get(id)?.meeting_id ?? ""),
      ...findingIds.map((id) => findings.get(id)?.meeting_id ?? ""),
      ...documentIds.map((id) => documentMeetingIds.get(id) ?? ""),
    ]),
  ].filter((id) => id.length > 0);

  const meetings = await meetingContexts(db, contextMeetingIds);
  const { byDocument, byMeeting } = await documentSources(db, documentIds, meetingEventIds);

  const entries: FeedEntry[] = [];

  for (const row of rows) {
    if (row.event_type.endsWith(".retracted")) {
      entries.push(retractionEntry(row, homeUrl));
      continue;
    }

    switch (row.subject_kind) {
      case "meeting": {
        const context = meetings.get(row.subject_id);
        if (context === undefined) break;
        const source = byMeeting.get(row.subject_id);
        entries.push({
          urn: eventUrn(row.id),
          title: `${context.commission_name} — meeting of ${dateText(context.meeting_date)}`,
          summary: `The meeting record for ${context.jurisdiction_name} is published.`,
          url: `${homeUrl}/meetings/${row.subject_id}`,
          updated: row.occurred_at,
          retraction: false,
          citation:
            source === undefined
              ? recordCitation(
                  homeUrl,
                  `/meetings/${row.subject_id}`,
                  `The meeting record — ${meetingLabel(context)}`,
                )
              : source,
        });
        break;
      }

      case "finding": {
        const finding = findings.get(row.subject_id);
        if (finding === undefined) break;
        const context =
          finding.meeting_id === null ? undefined : meetings.get(finding.meeting_id);
        entries.push({
          urn: eventUrn(row.id),
          // The flag type and severity, not a sentence about the finding. The
          // operator-approved description is the body, where it already is on
          // `/api/anomalies`, rather than reworded into a headline here.
          title: `Finding (${finding.severity}): ${finding.flag_type}`,
          summary: finding.description,
          // The frontend has `/findings` and no `/findings/:id` — checked in
          // `App.tsx`, not assumed — so a per-finding path would be a link that
          // renders the 404 page in every reader's client. A meeting-derived
          // finding goes to its meeting, which is where it is shown; a
          // records-derived one has no meeting and goes to the list.
          url:
            finding.meeting_id === null
              ? `${homeUrl}/findings`
              : `${homeUrl}/meetings/${finding.meeting_id}`,
          updated: row.occurred_at,
          retraction: false,
          citation:
            finding.source_url === null
              ? recordCitation(
                  homeUrl,
                  finding.meeting_id === null ? "/findings" : `/meetings/${finding.meeting_id}`,
                  `The record this was detected in — ${meetingLabel(context)}`,
                )
              : {
                  label: `The document this was detected in — ${meetingLabel(context)}`,
                  url: finding.source_url,
                  sha256: finding.sha256,
                },
        });
        break;
      }

      case "claim": {
        const claim = claims.get(row.subject_id);
        if (claim === undefined) break;
        const context = meetings.get(claim.meeting_id);
        entries.push({
          urn: eventUrn(row.id),
          // The pinned sentence, not a feed-local rewording of it. The meeting
          // is appended because a headline naming a person with no record
          // around it is the standalone-dossier shape the published-claim spec
          // rejects — in a subject line as much as on a page.
          title: `${claim.text} — ${meetingLabel(context)}`,
          // The quote is the claim. Everything else is scaffolding around a
          // verbatim span of a stored artifact, per that spec's second rule.
          summary: `“${claim.quote}”`,
          // A claim is not a page. It renders at `#claim-{id}` inside the
          // meeting it came from, because a page whose whole content is one
          // sentence about one named person is an accusation rather than a
          // record. Published-claim design § 3.
          url: `${homeUrl}/meetings/${claim.meeting_id}#claim-${claim.id}`,
          updated: row.occurred_at,
          retraction: false,
          citation:
            claim.source_url === null
              ? recordCitation(
                  homeUrl,
                  `/meetings/${claim.meeting_id}`,
                  `The minutes — ${meetingLabel(context)}`,
                )
              : {
                  label: `The minutes this was quoted from — ${meetingLabel(context)}`,
                  url: claim.source_url,
                  sha256: claim.artifact_sha256,
                },
        });
        break;
      }

      case "document": {
        const meetingId = documentMeetingIds.get(row.subject_id);
        const source = byDocument.get(row.subject_id);
        if (meetingId === undefined || source === undefined) break;
        const context = meetings.get(meetingId);
        entries.push({
          urn: eventUrn(row.id),
          title: `Document added — ${source.label}`,
          summary: `Added to the record for ${meetingLabel(context)}.`,
          url: `${homeUrl}/meetings/${meetingId}`,
          updated: row.occurred_at,
          retraction: false,
          citation: source,
        });
        break;
      }

      default:
        // `ops` never reaches here — `whereEventPublic` removed it — and an
        // unknown kind added by a later migration is dropped rather than
        // rendered with a guessed title.
        break;
    }
  }

  return entries;
}
