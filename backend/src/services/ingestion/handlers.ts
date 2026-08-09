import type { Knex } from "knex";
import type { AdapterRegistry } from "./adapters/registry";
import { asDocumentKind } from "./adapters/types";
import type { DocumentRef, MeetingRef, SourceAdapter } from "./adapters/types";
import { extractAgendaItems } from "./agenda-items";
import { extractPdfText, UnsupportedDocumentError } from "./pdf-text";
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

/** Replaces a meeting's agenda items with `drafts`. Idempotent on ordinal. */
export async function upsertAgendaItems(
  db: Knex,
  meetingId: string,
  drafts: ReadonlyArray<{
    itemNumber: number;
    title: string;
    description: string | null;
    category: string | null;
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
        created_at: db.fn.now(),
        updated_at: db.fn.now(),
      })),
    )
    .onConflict(["meeting_id", "item_number"])
    .merge({
      title: db.raw("excluded.title"),
      description: db.raw("excluded.description"),
      category: db.raw("excluded.category"),
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

      return {
        counts: {
          meetings_seen: meetings.length,
          meetings_inserted: inserted,
          documents_seen: documents,
          meetings_unattributed: unattributed,
        },
      };
    },

    async fetch(ctx): Promise<StageResult> {
      const source = await resolveSource(db, registry, ctx.runId);
      const ref = parseDocumentRefMetadata(ctx.target.metadata);
      const fetched = await source.adapter.fetchDocument(ref);

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
      const isNew = Array.isArray(rows) && rows.length > 0;

      if (isNew) {
        await ctx.enqueue("parse", {
          sha256: fetched.sha256,
          meetingId: ctx.target.meetingId,
          documentType: ctx.target.documentType,
        });
        return { counts: { artifacts_stored: 1, bytes_fetched: fetched.byteSize } };
      }
      return { counts: { artifacts_unchanged: 1 } };
    },

    async parse(ctx): Promise<StageResult> {
      const meetingId = ctx.target.meetingId;
      if (meetingId === undefined) {
        // Nothing to attach items to. Not an error and not a retry: a document
        // with no meeting is still stored and still citable.
        return { counts: { parse_unattached: 1 } };
      }
      if (ctx.target.documentType !== undefined && ctx.target.documentType !== "agenda") {
        // Minutes, packets and attachments are stored and left for the parsers
        // that understand them. Extracting agenda items from minutes would
        // manufacture an agenda that was never published.
        return { counts: { parse_not_agenda: 1 } };
      }

      let text;
      try {
        text = await extractPdfText(ctx.content, ctx.artifact.contentType);
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

      const extraction = extractAgendaItems(text.lines);
      const written = await upsertAgendaItems(db, meetingId, extraction.items);
      return {
        counts: {
          agenda_items_written: written,
          documents_parsed: 1,
          pages_read: text.pageCount,
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
