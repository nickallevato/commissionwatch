import type { Knex } from "knex";
import type { AdapterRegistry } from "./adapters/registry";
import { asDocumentKind } from "./adapters/types";
import type { DocumentRef, MeetingRef, SourceAdapter } from "./adapters/types";
import { snapshotFromDrafts } from "../agenda-diff";
import { extractAgendaItems, type FieldConfidenceMap } from "./agenda-items";
import { isCampaignFinanceKind, recordCampaignFinance } from "./campaign-finance";
import { extractDocumentText } from "./document-text";
import { UnsupportedDocumentError } from "./pdf-text";
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
 * Holds the text this parse extracted, so it can be searched.
 *
 * P6. The extraction has run since P1 and its output was thrown away the moment
 * agenda items were read out of it — which left the *body* of every document
 * unsearchable, and the body is where most terms appear. One row per artifact,
 * replaced on re-parse rather than accumulated: an artifact is content
 * addressed, so a second extraction of the same bytes is a better reading of the
 * same document, not a second document.
 *
 * It writes what was extracted and nothing else. No summary, no normalisation
 * beyond the line joining the extractor already did — the searchable text and
 * the text a reader would find in the stored bytes have to be the same thing.
 */
export async function recordArtifactText(
  db: Knex,
  artifactId: string,
  text: string,
): Promise<number> {
  await db("artifact_texts")
    .insert({
      artifact_id: artifactId,
      text,
      char_count: text.length,
      extracted_at: db.fn.now(),
    })
    .onConflict("artifact_id")
    .merge(["text", "char_count", "extracted_at", "updated_at"]);
  return text.length;
}

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
      const meetingId = ctx.target.meetingId;
      if (meetingId !== undefined) {
        const document: unknown = await db("meeting_documents")
          .where({ meeting_id: meetingId, url: ctx.target.url })
          .first("id");
        if (isRecord(document)) {
          const version = await recordDocumentVersion(
            db,
            requireString(document.id, "meeting_documents.id"),
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
        // PDF or HTML, decided on the bytes: Gallatin's agendas are PDFs and
        // Bozeman's are HTML, and both are agendas.
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
