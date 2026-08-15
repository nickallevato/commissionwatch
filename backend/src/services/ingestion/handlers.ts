import type { Knex } from "knex";
import type { AdapterRegistry } from "./adapters/registry";
import { asDocumentKind } from "./adapters/types";
import type { DocumentRef, MeetingRef, SourceAdapter } from "./adapters/types";
import { snapshotFromDrafts } from "../agenda-diff";
import { HttpStatusError } from "./adapters/http";
import { extractAgendaItems, type FieldConfidenceMap } from "./agenda-items";
import { recordArtifactText } from "./artifact-text";
import { isCampaignFinanceKind, recordCampaignFinance } from "./campaign-finance";
import { extractDocumentText } from "./document-text";
import { UnsupportedDocumentError } from "./pdf-text";
import {
  findMeetingDocumentId,
  readTranscript,
  recordTranscriptProjection,
  recordTranscriptStatus,
  transcriptFetchSettled,
} from "./transcripts";
import { parseWebVttCues } from "./webvtt";
import {
  readRecording,
  recordMeetingRecording,
  recordingFetchSettled,
} from "./recordings";
import type { ArtifactRef, HandlerRegistry, StageResult } from "./worker";

/**
 * The three stage handlers, built over the adapter registry.
 *
 * The worker knows nothing about any source; these do. Everything
 * source-specific arrives through `AdapterRegistry`, so a second jurisdiction
 * is a `register()` call and a row in `ingestion_sources`, not an edit here.
 *
 * The capability split the worker enforces is honoured rather than worked
 * around: `discover` and `fetch` reach the network through the adapter, and
 * `parse` receives bytes the fetch stage already captured. There is no code
 * path from `parse` back to a URL.
 */

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** Where fetched bytes are put. Injected so tests need no object store. */
export interface ArtifactWriter {
  write(key: string, bytes: Uint8Array, contentType: string | null): Promise<void>;
}

export interface HandlerLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface IngestionHandlerOptions {
  db: Knex;
  registry: AdapterRegistry;
  artifacts: ArtifactWriter;
  logger?: HandlerLogger;
}

/** The object key an artifact's bytes live under. Content-addressed. */
export function artifactStorageKey(sha256: string): string {
  return `artifacts/${sha256.slice(0, 2)}/${sha256}`;
}

// ---------------------------------------------------------------------------
// Row validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`${field}: expected a non-empty string`);
  }
  return value;
}

export interface SourceContext {
  sourceId: string;
  jurisdictionId: string;
  adapterKey: string;
  adapter: SourceAdapter;
}

/**
 * Resolves the run back to its source and adapter.
 *
 * The job target deliberately does not carry a source id: `ingestion_runs`
 * already owns that relationship, and duplicating it into every target would
 * let the two disagree.
 */
export async function resolveSource(
  db: Knex,
  registry: AdapterRegistry,
  runId: string,
): Promise<SourceContext> {
  const row: unknown = await db("ingestion_runs")
    .join("ingestion_sources", "ingestion_runs.source_id", "ingestion_sources.id")
    .where("ingestion_runs.id", runId)
    .first(
      "ingestion_sources.id as source_id",
      "ingestion_sources.jurisdiction_id",
      "ingestion_sources.adapter_key",
    );
  if (!isRecord(row)) {
    throw new Error(`ingestion run ${runId} has no source`);
  }
  const adapterKey = requireString(row.adapter_key, "ingestion_sources.adapter_key");
  return {
    sourceId: requireString(row.source_id, "ingestion_sources.id"),
    jurisdictionId: requireString(row.jurisdiction_id, "ingestion_sources.jurisdiction_id"),
    adapterKey,
    adapter: registry.get(adapterKey),
  };
}

// ---------------------------------------------------------------------------
// Target payloads
// ---------------------------------------------------------------------------

/**
 * A `DocumentRef` round-tripped through `ingestion_jobs.target.metadata`.
 *
 * Validated on the way back out rather than trusted: the row may have been
 * written by an older build, and a malformed one must fail as invalid rather
 * than reach an adapter half-formed.
 */
export function parseDocumentRefMetadata(metadata: unknown): DocumentRef {
  if (!isRecord(metadata) || !isRecord(metadata.ref)) {
    throw new TypeError("fetch target metadata: expected a 'ref' object");
  }
  const ref = metadata.ref;
  const kind = asDocumentKind(ref.kind);
  if (kind === null) {
    throw new TypeError(`fetch target metadata: unknown document kind ${String(ref.kind)}`);
  }
  const parsed: DocumentRef = {
    sourceKey: requireString(ref.sourceKey, "ref.sourceKey"),
    kind,
    title: requireString(ref.title, "ref.title"),
    url: requireString(ref.url, "ref.url"),
  };
  if (typeof ref.meetingExternalId === "string") {
    parsed.meetingExternalId = ref.meetingExternalId;
  }
  if (typeof ref.expectedContentType === "string") {
    parsed.expectedContentType = ref.expectedContentType;
  }
  // Adapter-specific chain parameters. Narrowed to strings rather than trusted,
  // because this came back out of a jsonb column and a nested object here would
  // be a shape nobody validated reaching an adapter.
  if (isRecord(ref.metadata)) {
    const carried: Record<string, string> = {};
    for (const [key, value] of Object.entries(ref.metadata)) {
      if (typeof value === "string") carried[key] = value;
    }
    if (Object.keys(carried).length > 0) parsed.metadata = carried;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface CommissionLookup {
  /** bodyKey -> commissions.id */
  byBodyKey: Map<string, string>;
}

/**
 * Maps the adapter's body keys onto `commissions` rows.
 *
 * Registration created one commission per declared body, named by the
 * descriptor. A body the descriptor no longer declares keeps its commission and
 * its meetings — ingestion never deletes a public record.
 */
async function loadCommissions(
  db: Knex,
  jurisdictionId: string,
  adapter: SourceAdapter,
): Promise<CommissionLookup> {
  const descriptor = adapter.describeSource();
  const nameByKey = new Map(descriptor.bodies.map((body) => [body.key, body.name]));
  const rows: unknown = await db("commissions")
    .where({ jurisdiction_id: jurisdictionId })
    .select("id", "name");
  const idByName = new Map<string, string>();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isRecord(row)) continue;
    idByName.set(requireString(row.name, "commissions.name"), requireString(row.id, "commissions.id"));
  }
  const byBodyKey = new Map<string, string>();
  for (const [key, name] of nameByKey) {
    const id = idByName.get(name);
    if (id !== undefined) byBodyKey.set(key, id);
  }
  return { byBodyKey };
}

export interface UpsertMeetingResult {
  meetingId: string;
  inserted: boolean;
}

/**
 * Inserts or revises one meeting, keyed on the source's own identifier.
 *
 * A meeting the source gives no identifier for is matched on
 * `(commission_id, date, external_id IS NULL)` — which can collide when a body
 * meets twice in a day, so an adapter that emits no `externalId` is
 * lower-fidelity by construction. Gallatin emits one for every row.
 */
export async function upsertMeeting(
  db: Knex,
  commissionId: string,
  ref: MeetingRef,
): Promise<UpsertMeetingResult> {
  const base = {
    commission_id: commissionId,
    date: ref.date,
    status: ref.status,
    updated_at: db.fn.now(),
  };
  const optional: Record<string, string> = {};
  if (ref.time !== undefined) optional.time = ref.time;
  if (ref.location !== undefined) optional.location = ref.location;

  if (ref.externalId === undefined) {
    const existing: unknown = await db("meetings")
      .where({ commission_id: commissionId, date: ref.date })
      .whereNull("external_id")
      .first("id");
    if (isRecord(existing)) {
      const id = requireString(existing.id, "meetings.id");
      await db("meetings").where({ id }).update({ ...base, ...optional });
      return { meetingId: id, inserted: false };
    }
    const inserted: unknown = await db("meetings")
      .insert({ ...base, ...optional, created_at: db.fn.now() })
      .returning("id");
    const row = Array.isArray(inserted) ? inserted[0] : undefined;
    if (!isRecord(row)) throw new Error("meetings insert returned no row");
    return { meetingId: requireString(row.id, "meetings.id"), inserted: true };
  }

  const rows: unknown = await db("meetings")
    .insert({ ...base, ...optional, external_id: ref.externalId, created_at: db.fn.now() })
    .onConflict(["commission_id", "external_id"])
    .merge({ ...base, ...optional })
    .returning(["id", "created_at", "updated_at"]);
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!isRecord(row)) throw new Error("meetings upsert returned no row");
  const meetingId = requireString(row.id, "meetings.id");
  // `xmax = 0` is the honest way to ask Postgres whether an upsert inserted,
  // but it is not in RETURNING here; created_at === updated_at is exact enough
  // for a count and never wrong in the direction that matters.
  const created = row.created_at instanceof Date ? row.created_at.getTime() : 0;
  const updated = row.updated_at instanceof Date ? row.updated_at.getTime() : 0;
  return { meetingId, inserted: created === updated };
}

/** Records a document against its meeting. Idempotent on `(meeting_id, url)`. */
export async function upsertMeetingDocument(
  db: Knex,
  meetingId: string,
  ref: DocumentRef,
): Promise<void> {
  await db("meeting_documents")
    .insert({
      meeting_id: meetingId,
      title: ref.title,
      document_type: ref.kind,
      url: ref.url,
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    })
    .onConflict(["meeting_id", "url"])
    .merge({ title: ref.title, document_type: ref.kind, updated_at: db.fn.now() });
}

// ---------------------------------------------------------------------------
// Version history
// ---------------------------------------------------------------------------

export interface RecordVersionResult {
  /** `false` when this artifact was already a version of this document. */
  created: boolean;
  versionNo: number;
}

/**
 * Records that `artifactId` is a version of `meetingDocumentId`.
 *
 * Called on **every** successful fetch, with no prior "have I seen this
 * before?" question — that question is the bug this design avoids, because a
 * hand-written seen-set and the content address can disagree and then only one
 * of them is the record. Instead the constraints decide:
 *
 * - unchanged bytes resolve to the same `artifacts` row and collide on
 *   `unique (meeting_document_id, artifact_id)`, creating nothing
 * - changed bytes are a new artifact and create exactly one version
 *
 * The parent document row is locked for the duration so two concurrent fetches
 * of the same document cannot both read the same `MAX(version_no)` and race for
 * the same number. The worker runs one job at a time today; the lock is what
 * makes that an implementation detail rather than a load-bearing assumption.
 *
 * `first_seen_at` is the artifact's own `fetched_at`, not `now()`: the version
 * appeared when we first held the bytes, and a later backfill or replay must
 * not restate that moment.
 */
export async function recordDocumentVersion(
  db: Knex,
  meetingDocumentId: string,
  artifactId: string,
  firstSeenAt: Date | string,
): Promise<RecordVersionResult> {
  return db.transaction(async (trx) => {
    await trx("meeting_documents").where({ id: meetingDocumentId }).forUpdate().first("id");

    const existing: unknown = await trx("document_versions")
      .where({ meeting_document_id: meetingDocumentId, artifact_id: artifactId })
      .first("version_no");
    if (isRecord(existing)) {
      return { created: false, versionNo: Number(existing.version_no) };
    }

    const highest: unknown = await trx("document_versions")
      .where({ meeting_document_id: meetingDocumentId })
      .max("version_no as max")
      .first();
    const previous = isRecord(highest) ? Number(highest.max ?? 0) : 0;
    const versionNo = (Number.isFinite(previous) ? previous : 0) + 1;

    // The same bytes may already have been extracted under another document.
    // The snapshot is a property of the artifact, so it is carried across
    // rather than left NULL and re-derived — a re-parse is not available here.
    const sibling: unknown = await trx("document_versions")
      .where({ artifact_id: artifactId })
      .whereNotNull("item_snapshot")
      .first("item_snapshot");
    const snapshot = isRecord(sibling) ? sibling.item_snapshot : null;

    await trx("document_versions").insert({
      meeting_document_id: meetingDocumentId,
      artifact_id: artifactId,
      version_no: versionNo,
      first_seen_at: firstSeenAt,
      item_snapshot: snapshot === null || snapshot === undefined ? null : JSON.stringify(snapshot),
      created_at: trx.fn.now(),
      updated_at: trx.fn.now(),
    });
    return { created: true, versionNo };
  });
}

/**
 * Attaches the extracted items to every version row carrying this artifact.
 *
 * Keyed on the artifact rather than on the document because the extraction is a
 * property of the bytes: the same agenda filed under two documents yields the
 * same items, and deriving it twice would let the two answers drift.
 */
export async function recordVersionSnapshot(
  db: Knex,
  artifactId: string,
  items: ReadonlyArray<{ item_number: number; title: string }>,
): Promise<number> {
  return db("document_versions")
    .where({ artifact_id: artifactId })
    .update({ item_snapshot: JSON.stringify(items), updated_at: db.fn.now() });
}

/**
 * Re-exported from `./artifact-text`, which is where it now lives.
 *
 * It moved so `ingestion/transcripts.ts` can use the one text-indexing path
 * without the two modules importing each other. Existing callers — and
 * `backfill-artifact-text.ts` is one — keep importing it from here.
 */
export { recordArtifactText };

/**
 * Replaces a meeting's agenda items with `drafts`. Idempotent on ordinal.
 *
 * `field_confidence` is written alongside the values it describes, in the same
 * statement, so a re-parse can never leave last parse's marks attached to this
 * parse's text. A draft that carries no assessment writes `{}` — no marks,
 * which is not the same as a clean bill of health and does not claim to be.
 */
export async function upsertAgendaItems(
  db: Knex,
  meetingId: string,
  drafts: ReadonlyArray<{
    itemNumber: number;
    title: string;
    description: string | null;
    category: string | null;
    confidence?: FieldConfidenceMap;
  }>,
): Promise<number> {
  if (drafts.length === 0) return 0;
  await db("agenda_items")
    .insert(
      drafts.map((draft) => ({
        meeting_id: meetingId,
        item_number: draft.itemNumber,
        title: draft.title,
        description: draft.description,
        category: draft.category,
        field_confidence: JSON.stringify(draft.confidence ?? {}),
        created_at: db.fn.now(),
        updated_at: db.fn.now(),
      })),
    )
    .onConflict(["meeting_id", "item_number"])
    .merge({
      title: db.raw("excluded.title"),
      description: db.raw("excluded.description"),
      category: db.raw("excluded.category"),
      field_confidence: db.raw("excluded.field_confidence"),
      updated_at: db.fn.now(),
    });
  return drafts.length;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const silentLogger: HandlerLogger = { info: () => {}, warn: () => {} };

export function createIngestionHandlers(
  options: IngestionHandlerOptions,
): HandlerRegistry {
  const { db, registry, artifacts } = options;
  const logger = options.logger ?? silentLogger;

  return {
    async discover(ctx): Promise<StageResult> {
      const source = await resolveSource(db, registry, ctx.runId);
      const since = new Date(ctx.target.since);
      const meetings = await source.adapter.discoverMeetings(since);
      const commissions = await loadCommissions(db, source.jurisdictionId, source.adapter);

      let inserted = 0;
      let documents = 0;
      let unattributed = 0;
      let transcriptsSettled = 0;
      let recordingsSettled = 0;

      for (const ref of meetings) {
        const commissionId = commissions.byBodyKey.get(ref.bodyKey);
        if (commissionId === undefined) {
          // A body the descriptor declares but registration never created, or a
          // body the adapter invented. Counted and logged, never guessed at:
          // filing meetings under a commission nobody configured would put a
          // false statement on a transparency site.
          unattributed += 1;
          logger.warn(
            `discover: no commission for body '${ref.bodyKey}' in jurisdiction ${source.jurisdictionId}`,
          );
          continue;
        }

        const result = await upsertMeeting(db, commissionId, ref);
        if (result.inserted) inserted += 1;

        const urls: { agenda_url?: string; minutes_url?: string } = {};
        for (const document of ref.documents) {
          await upsertMeetingDocument(db, result.meetingId, document);
          documents += 1;
          if (document.kind === "agenda" && urls.agenda_url === undefined) {
            urls.agenda_url = document.url;
          }
          if (document.kind === "minutes" && urls.minutes_url === undefined) {
            urls.minutes_url = document.url;
          }
          if (document.kind === "transcript") {
            // Granicus sends no ETag, no Last-Modified and no Content-Length on
            // the captions endpoint, so `fetchDocument`'s conditional request can
            // never receive a 304 and every re-check is a full download at ten
            // seconds a request. This is the only place in the pipeline that can
            // decide not to ask, because it is the first stage with a database
            // connection. See `transcriptFetchSettled` for what settled means and
            // why `absent` is not permanent.
            const documentId = await findMeetingDocumentId(db, result.meetingId, document.url);
            if (
              documentId !== null &&
              (await transcriptFetchSettled(db, documentId, ref.date, new Date()))
            ) {
              transcriptsSettled += 1;
              continue;
            }
          }
          if (document.kind === "recording") {
            // The same gate, for the same reason: no ETag on this host, so a
            // re-check is a full 76 KB download at one request per ten seconds,
            // and the player page for a 2015 meeting will never change again.
            const documentId = await findMeetingDocumentId(db, result.meetingId, document.url);
            if (
              documentId !== null &&
              (await recordingFetchSettled(db, documentId, ref.date, new Date()))
            ) {
              recordingsSettled += 1;
              continue;
            }
          }
          await ctx.enqueue("fetch", {
            url: document.url,
            meetingId: result.meetingId,
            documentType: document.kind,
            metadata: { ref: { ...document } },
          });
        }
        if (Object.keys(urls).length > 0) {
          await db("meetings").where({ id: result.meetingId }).update(urls);
        }
      }

      // Documents that belong to no meeting. Campaign-finance filings are the
      // first of these: a filed C-5 belongs to a candidacy and a reporting
      // period, and there is no meeting anywhere in it. They are enqueued for
      // `fetch` with no meeting id, so they are stored, content-addressed and
      // citable exactly like any other artifact — and the alternative was to
      // invent a meeting per filing period so this loop would accept them,
      // which would have put a fabricated public record in `meetings`.
      let standalone = 0;
      if (source.adapter.discoverDocuments !== undefined) {
        const refs = await source.adapter.discoverDocuments(since);
        for (const document of refs) {
          standalone += 1;
          await ctx.enqueue("fetch", {
            url: document.url,
            documentType: document.kind,
            metadata: { ref: { ...document } },
          });
        }
      }

      return {
        counts: {
          meetings_seen: meetings.length,
          meetings_inserted: inserted,
          documents_seen: documents,
          meetings_unattributed: unattributed,
          standalone_documents_seen: standalone,
          // Descriptive, in neither SUCCESS_KEYS nor FAILURE_KEYS: not asking
          // again for a settled transcript is the policy working, not a gap.
          transcripts_settled: transcriptsSettled,
          recordings_settled: recordingsSettled,
        },
      };
    },

    async fetch(ctx): Promise<StageResult> {
      const source = await resolveSource(db, registry, ctx.runId);
      const ref = parseDocumentRefMetadata(ctx.target.metadata);
      const isTranscript = ref.kind === "transcript";
      const clipId = ref.metadata?.clipId ?? "";
      const meetingId = ctx.target.meetingId;

      let fetched;
      try {
        fetched = await source.adapter.fetchDocument(ref);
      } catch (error) {
        // An unknown clip id on this host answers **500**, not 404 — probed
        // 2026-08-14, clip 999999, 2,512 bytes of Slim framework HTML. Retrying it
        // three times at ten seconds apart buys nothing, so the answer is recorded
        // and the job completes. `failed` is incremented alongside the descriptive
        // count because failing to obtain a public record is a real failure and
        // both `failuresIn` and `classifyRun` have to see it.
        if (isTranscript && error instanceof HttpStatusError && meetingId !== undefined) {
          const documentId = await findMeetingDocumentId(db, meetingId, ctx.target.url);
          if (documentId !== null) {
            await recordTranscriptStatus(db, {
              meetingDocumentId: documentId,
              clipId,
              state: "unavailable",
              observedSha256: null,
              cueCount: null,
              lastError: `HTTP ${error.status} from ${error.url}`,
              observedAt: new Date(),
            });
            return { counts: { transcripts_unavailable: 1, failed: 1 } };
          }
        }
        throw error;
      }

      const storageKey = artifactStorageKey(fetched.sha256);
      await artifacts.write(storageKey, fetched.bytes, fetched.contentType);

      const rows: unknown = await db("artifacts")
        .insert({
          sha256: fetched.sha256,
          storage_key: storageKey,
          content_type: fetched.contentType,
          source_url: fetched.sourceUrl,
          byte_size: fetched.byteSize,
          fetched_at: fetched.fetchedAt,
          created_at: db.fn.now(),
          updated_at: db.fn.now(),
        })
        // The content address is unique, so re-fetching an unchanged document
        // collides here and the pipeline stops. That is the "never re-process an
        // unchanged document" rule expressed as a constraint rather than as an
        // intention.
        .onConflict("sha256")
        .ignore()
        .returning("id");
      const insertedRow = Array.isArray(rows) ? rows[0] : undefined;
      const isNew = isRecord(insertedRow);

      // The artifact id is needed either way now, because a version row is
      // written on every successful fetch — including one that changed nothing.
      // Letting the collision short-circuit before this point is what kept
      // `meeting_documents` and `artifacts` unjoined for thirty-four migrations.
      let artifactId: string;
      if (isNew) {
        artifactId = requireString(insertedRow.id, "artifacts.id");
      } else {
        const existing: unknown = await db("artifacts")
          .where({ sha256: fetched.sha256 })
          .first("id");
        if (!isRecord(existing)) {
          throw new Error(`artifact ${fetched.sha256} neither inserted nor found`);
        }
        artifactId = requireString(existing.id, "artifacts.id");
      }

      const counts: Record<string, number> = isNew
        ? { artifacts_stored: 1, bytes_fetched: fetched.byteSize }
        : { artifacts_unchanged: 1 };

      // Version history is a consequence of the fetch path. The document is
      // located by the URL this job was told to fetch, which is the same key
      // `upsertMeetingDocument` wrote under.
      let meetingDocumentId: string | null = null;
      if (meetingId !== undefined) {
        meetingDocumentId = await findMeetingDocumentId(db, meetingId, ctx.target.url);
        if (meetingDocumentId !== null) {
          const version = await recordDocumentVersion(
            db,
            meetingDocumentId,
            artifactId,
            fetched.fetchedAt,
          );
          if (version.created) counts.document_versions_created = 1;
        } else {
          // A fetch with no document row behind it. Counted rather than
          // guessed at: inventing the document would attach a version to a
          // record nobody published.
          counts.document_versions_unattached = 1;
          logger.warn(
            `fetch: no meeting_documents row for ${ctx.target.url} on meeting ${meetingId}`,
          );
        }
      }

      // THE LOAD-BEARING LINE OF THIS FEATURE: **outside the `isNew` branch.**
      //
      // Every empty caption file Bozeman serves is the same eight bytes,
      // `WEBVTT\n\n`, and therefore the same sha256 — reproducible by anyone with
      // `printf 'WEBVTT\n\n' | sha256sum`. `artifacts.sha256` is uniquely indexed,
      // so from the second absence onward `isNew` is false, no `parse` job is
      // enqueued, and `artifacts.source_url` names a different meeting's clip. If
      // the state were written by `parse`, or written only when the artifact was
      // new, a thousand distinct absences would be represented by one row naming
      // one of them, and the site would be unable to say that this meeting has no
      // published transcript. Recording it here, per meeting document, on every
      // pass, is the difference between the feature working and appearing to.
      if (isTranscript && meetingDocumentId !== null) {
        const reading = readTranscript(fetched.bytes, fetched.contentType);
        await recordTranscriptStatus(db, {
          meetingDocumentId,
          clipId,
          state: reading.state,
          observedSha256: fetched.sha256,
          cueCount: reading.cues === null ? null : reading.cues.length,
          lastError: reading.lastError,
          observedAt: fetched.fetchedAt,
        });
        if (reading.state === "published") {
          counts.transcripts_published = 1;
        } else if (reading.state === "absent") {
          // Descriptive only, in neither SUCCESS_KEYS nor FAILURE_KEYS. **An
          // absence is not a failure.** The custodian served a well-formed file
          // saying there is nothing here, and 8 of 8 sampled clips from 2013-2020
          // say exactly that. Counting it as a failure would make an era of the
          // city's own practice read as a broken fetcher.
          counts.transcripts_absent = 1;
        } else {
          counts.transcripts_unavailable = 1;
          counts.failed = (counts.failed ?? 0) + 1;
        }
      }

      // The recording index, written here for the second of the two reasons the
      // block above is written here. Player pages do not collapse onto one
      // artifact the way the caption stub does — each names its own media id —
      // but an unchanged re-fetch still leaves `isNew` false and enqueues no
      // `parse` job, so a parse-side write could never bump `last_checked_at`.
      // "We looked again and it still says 2h 56m" needs a writer on every pass.
      //
      // Nothing here reaches the media. It cannot: `archive-video.granicus.com`
      // is not in the adapter's `allowedOrigins` and refuses this project's user
      // agent anyway. What is recorded is what the custodian's own page states.
      if (ref.kind === "recording" && meetingDocumentId !== null) {
        const reading = readRecording(fetched.bytes);
        await recordMeetingRecording(db, {
          meetingDocumentId,
          clipId,
          reading,
          observedSha256: fetched.sha256,
          observedAt: fetched.fetchedAt,
        });
        if (reading.state === "available") {
          counts.recordings_available = 1;
        } else {
          // Unlike an absent transcript, this is a failure and is counted as one.
          // An absence is the custodian's record; a page we could not read is
          // ours, and `failuresIn` and `classifyRun` both have to see it.
          counts.recordings_unreadable = 1;
          counts.failed = (counts.failed ?? 0) + 1;
        }
      }

      if (isNew) {
        // The ref's own metadata travels on, so a stage that reads stored bytes
        // still knows what record they are. It carries no URL and cannot be
        // turned into one — the capability split is about dereferencing, not
        // about forgetting what was fetched.
        await ctx.enqueue("parse", {
          sha256: fetched.sha256,
          meetingId: ctx.target.meetingId,
          documentType: ctx.target.documentType,
          ...(ref.metadata === undefined
            ? {}
            : { metadata: { ...ref.metadata, sourceUrl: fetched.sourceUrl } }),
        });
      }
      return { counts };
    },

    async parse(ctx): Promise<StageResult> {
      // A record that is not a meeting document routes first, on the record
      // kind its own adapter stamped. Nothing here sniffs the bytes: a stored
      // artifact's meaning comes from the ref that asked for it, and guessing
      // it from the content would let a JSON agenda become a campaign filing.
      const recordKind = isRecord(ctx.target.metadata)
        ? ctx.target.metadata.recordKind
        : undefined;
      if (isCampaignFinanceKind(recordKind)) {
        const source = await resolveSource(db, registry, ctx.runId);
        return {
          counts: await recordCampaignFinance(
            {
              db,
              sourceId: source.sourceId,
              artifactId: ctx.artifact.id,
              metadata: ctx.target.metadata,
            },
            ctx.content,
          ),
        };
      }

      if (ctx.target.documentType === "transcript") {
        // A caption file is neither PDF nor HTML, so it routes before
        // `extractDocumentText` — which would raise `UnsupportedDocumentError` and
        // file a real transcript as `parse_unsupported`. It also needs the cue
        // timings written in the same transaction as the text they index, which is
        // why it does not simply become a third case inside that extractor.
        //
        // `parseWebVttCues` throws with the offending line number rather than
        // skipping what it cannot read, and that throw lands in
        // `ingestion_jobs.last_error` with nothing written to `artifact_texts` or
        // `transcript_cues`. A parser that dropped a bad cue would produce a
        // transcript with a hole in it that reads exactly like a transcript
        // without one.
        const cues = parseWebVttCues(ctx.content);
        if (cues.length === 0) {
          // The empty stub. `transcript_status` already recorded `absent` at fetch
          // time; there is nothing here to index, and an empty `artifact_texts`
          // row would be a searchable document containing no words.
          return { counts: { transcripts_empty: 1 } };
        }
        const written = await recordTranscriptProjection(db, ctx.artifact.id, cues);
        return {
          counts: {
            documents_parsed: 1,
            artifact_text_chars: written.charsIndexed,
            transcript_cues_written: written.cuesIndexed,
          },
        };
      }

      if (ctx.target.documentType === "recording") {
        // **A player page is never indexed into `artifact_texts`.**
        //
        // It is 76 KB of HTML that is almost entirely stylesheet, jQuery and
        // player configuration; `extractDocumentText` would read it happily and
        // put that into the corpus `/api/search` reads, so a reader searching for
        // a phrase said at a meeting would get hits on `flowplayer` and
        // `durationInputInSecs`. The document's substance — the media id and the
        // recording's length — is already in `meeting_recordings`, written at
        // fetch time and addressable there.
        //
        // The bytes are still stored, still content-addressed and still citable,
        // which is what makes the duration checkable. Not indexing is a statement
        // about search, not about provenance.
        return { counts: { recordings_not_indexed: 1 } };
      }

      const meetingId = ctx.target.meetingId;
      if (meetingId === undefined) {
        // Nothing to attach items to. Not an error and not a retry: a document
        // with no meeting is still stored and still citable.
        return { counts: { parse_unattached: 1 } };
      }
      let text;
      try {
        // PDF or HTML, decided on the bytes: Gallatin's agendas are PDFs and
        // Bozeman's are HTML, and both are agendas. Minutes are both too, which
        // is why this now runs before the document-type check rather than after.
        text = await extractDocumentText(ctx.content, ctx.artifact.contentType);
      } catch (error) {
        if (error instanceof UnsupportedDocumentError) {
          // Gallatin serves Word documents behind ViewFile/Agenda paths. The
          // bytes are held and the gap is counted; it is a fact about the
          // record, not a failure of the fetch.
          logger.info(`parse: ${error.message}`);
          return { counts: { parse_unsupported: 1 } };
        }
        throw error;
      }

      // Held before the items are extracted, because the two answer different
      // questions and the second one failing must not lose the first. A
      // document whose items cannot be read is still searchable by its text.
      const charsIndexed = await recordArtifactText(db, ctx.artifact.id, text.lines.join("\n"));

      if (ctx.target.documentType !== undefined && ctx.target.documentType !== "agenda") {
        // Minutes, packets and attachments are left for the parsers that
        // understand them. Extracting agenda items from minutes would
        // manufacture an agenda that was never published — that part was always
        // right, and it is the only thing this branch should ever have decided.
        //
        // It used to return *above* `recordArtifactText`, which meant the rule
        // against inventing agenda items also silently withheld the document's
        // text from `artifact_texts` — the table `services/search.ts` reads for
        // document bodies. Every set of minutes, every packet and every
        // attachment this project has ever fetched was stored, content
        // addressed, and never indexed. Minutes are the substance of the
        // record: they are what the extraction pipeline reads to produce claims,
        // and a reader searching for a phrase said at a meeting got nothing.
        //
        // The principle was already stated four lines up and merely applied to
        // the wrong set of documents. `document_versions` rows are written for
        // every meeting document at fetch time regardless of type, so the join
        // to the publication wall was already in place and waiting.
        return { counts: { parse_not_agenda: 1, artifact_text_chars: charsIndexed } };
      }

      const extraction = extractAgendaItems(text.lines);
      const written = await upsertAgendaItems(db, meetingId, extraction.items);

      // `agenda_items` cannot answer for a superseded version — it is merged on
      // `(meeting_id, item_number)`, so this parse has just overwritten the
      // previous one's rows. The snapshot is what remains diffable.
      const snapshotted = await recordVersionSnapshot(
        db,
        ctx.artifact.id,
        snapshotFromDrafts(extraction.items),
      );

      return {
        counts: {
          agenda_items_written: written,
          documents_parsed: 1,
          pages_read: text.pageCount,
          document_versions_snapshotted: snapshotted,
          artifact_text_chars: charsIndexed,
        },
      };
    },
  };
}

/** Adapts `ArtifactRef` reads onto the object store the fetch stage wrote to. */
export function createArtifactStore(read: (key: string) => Promise<Buffer>): {
  read(ref: ArtifactRef): Promise<Buffer>;
} {
  return { read: (ref) => read(ref.storageKey) };
}
