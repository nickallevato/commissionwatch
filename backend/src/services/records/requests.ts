import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import { uploadDocument } from '../storage';
import {
  extractEntities,
  EXTRACTOR_VERSION,
  namesAPerson,
  type ExtractedEntities,
} from './extraction';
import { detectRecordsFlags } from './detectors';
import { ensureApprovalRequests } from '../review/queue';

/**
 * Public-records requests, and the documents they produce.
 *
 * The organising decision: a document obtained by hand takes the **identical**
 * downstream path as a scraped one. It is hashed, stored, and written as an
 * `artifacts` row with `source_url` NULL — which is the case that table's own
 * migration comment was written to describe. Nothing here reimplements
 * document storage, and the archive's bespoke FOIA tables are not ported.
 */

export const RECORDS_REQUEST_STATUSES = [
  'draft',
  'submitted',
  'acknowledged',
  'partially_fulfilled',
  'fulfilled',
  'denied',
  'withdrawn',
] as const;

export type RecordsRequestStatus = (typeof RECORDS_REQUEST_STATUSES)[number];

export interface RecordsRequestRow {
  id: string;
  jurisdiction_id: string | null;
  subject: string;
  status: RecordsRequestStatus;
  submitted_at: Date | null;
  response_due_at: Date | null;
  responded_at: Date | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ArtifactRow {
  id: string;
  sha256: string;
  storage_key: string;
  content_type: string | null;
  source_url: string | null;
  byte_size: number;
  fetched_at: Date;
}

export interface IngestInput {
  filename: string;
  contentType?: string | null;
  content: Buffer;
  /** UTF-8 text of the document, when it is available. */
  text?: string | null;
  requestId?: string | null;
}

export interface IngestResult {
  artifact: ArtifactRow;
  /** False when identical bytes were already stored — nothing was reprocessed. */
  created: boolean;
  extraction: StoredExtraction | null;
  flagIds: string[];
  namesAPerson: boolean;
}

export interface StoredExtraction {
  id: string;
  artifact_id: string;
  entities: ExtractedEntities;
  extractor_version: string;
  supersedes_id: string | null;
  corrected_by: string | null;
  note: string | null;
  created_at: Date;
}

export class RecordsError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'RecordsError';
    this.statusCode = statusCode;
  }
}

/** The slice of `services/storage` this service needs, so tests need no MinIO. */
export interface DocumentStore {
  upload(key: string, data: Buffer, contentType: string): Promise<string>;
}

const defaultStore: DocumentStore = {
  upload: (key, data, contentType) => uploadDocument(key, data, contentType),
};

export interface RecordsServiceOptions {
  store?: DocumentStore;
  now?: () => Date;
}

export class RecordsService {
  private readonly store: DocumentStore;
  private readonly now: () => Date;

  constructor(
    private readonly db: Knex,
    options: RecordsServiceOptions = {},
  ) {
    this.store = options.store ?? defaultStore;
    this.now = options.now ?? (() => new Date());
  }

  // ---- request lifecycle -------------------------------------------------

  async createRequest(input: {
    subject: string;
    jurisdiction_id?: string | null;
    status?: RecordsRequestStatus;
    submitted_at?: Date | null;
    response_due_at?: Date | null;
    notes?: string | null;
  }): Promise<RecordsRequestRow> {
    const subject = input.subject.trim();
    if (subject === '') throw new RecordsError('A subject is required');

    const status = input.status ?? 'draft';
    if (!RECORDS_REQUEST_STATUSES.includes(status)) {
      throw new RecordsError(`"${status}" is not a records request status`);
    }

    if (input.jurisdiction_id) {
      const jurisdiction = await this.db('jurisdictions')
        .where({ id: input.jurisdiction_id })
        .first('id');
      if (!jurisdiction) throw new RecordsError('Jurisdiction not found');
    }

    const [row] = await this.db('records_requests')
      .insert({
        subject,
        jurisdiction_id: input.jurisdiction_id ?? null,
        status,
        submitted_at: input.submitted_at ?? (status === 'submitted' ? this.now() : null),
        response_due_at: input.response_due_at ?? null,
        notes: input.notes ?? null,
      })
      .returning<RecordsRequestRow[]>('*');

    return row;
  }

  async listRequests(): Promise<RecordsRequestRow[]> {
    return this.db<RecordsRequestRow>('records_requests')
      .orderBy('created_at', 'desc')
      .select('*');
  }

  async getRequest(
    id: string,
  ): Promise<{ request: RecordsRequestRow; artifacts: ArtifactRow[] } | null> {
    const request = await this.db<RecordsRequestRow>('records_requests').where({ id }).first();
    if (!request) return null;

    const artifacts = await this.db<ArtifactRow>('artifacts')
      .join('records_request_artifacts', 'artifacts.id', 'records_request_artifacts.artifact_id')
      .where('records_request_artifacts.request_id', id)
      .orderBy('artifacts.fetched_at', 'asc')
      .select(
        'artifacts.id',
        'artifacts.sha256',
        'artifacts.storage_key',
        'artifacts.content_type',
        'artifacts.source_url',
        'artifacts.byte_size',
        'artifacts.fetched_at',
      );

    return { request, artifacts };
  }

  async updateRequest(
    id: string,
    changes: {
      status?: RecordsRequestStatus;
      responded_at?: Date | null;
      response_due_at?: Date | null;
      notes?: string | null;
    },
  ): Promise<RecordsRequestRow | null> {
    if (changes.status && !RECORDS_REQUEST_STATUSES.includes(changes.status)) {
      throw new RecordsError(`"${changes.status}" is not a records request status`);
    }

    const update: Record<string, unknown> = { updated_at: this.now() };
    if (changes.status) {
      update.status = changes.status;
      // Moving to submitted stamps the date if the caller did not, so the
      // lifecycle cannot end up with a submitted request and no submission date.
      if (changes.status === 'submitted') update.submitted_at = this.now();
    }
    if (changes.responded_at !== undefined) update.responded_at = changes.responded_at;
    if (changes.response_due_at !== undefined) update.response_due_at = changes.response_due_at;
    if (changes.notes !== undefined) update.notes = changes.notes;

    if (Object.keys(update).length === 1) throw new RecordsError('No changes were supplied');

    const [row] = await this.db('records_requests')
      .where({ id })
      .update(update)
      .returning<RecordsRequestRow[]>('*');

    return row ?? null;
  }

  // ---- documents ---------------------------------------------------------

  /**
   * Hash, store, and process a document obtained by hand.
   *
   * Identical bytes collide on `artifacts.sha256` and are **never
   * reprocessed** — free deduplication, and the reason the content address is
   * unique in the first place. A re-upload still attaches the existing artifact
   * to the request, because "we already had this" and "this request produced
   * it" are different facts.
   */
  async ingestDocument(input: IngestInput): Promise<IngestResult> {
    if (input.content.length === 0) throw new RecordsError('The document is empty');

    const sha256 = createHash('sha256').update(input.content).digest('hex');
    const existing = await this.db<ArtifactRow>('artifacts').where({ sha256 }).first();

    if (existing) {
      if (input.requestId) await this.attachArtifact(input.requestId, existing.id);
      const extraction = await this.latestExtraction(existing.id);
      return {
        artifact: existing,
        created: false,
        extraction,
        flagIds: [],
        namesAPerson: extraction ? namesAPerson(extraction.entities) : false,
      };
    }

    const contentType = input.contentType?.trim() || 'application/octet-stream';
    const storageKey = `records/${sha256}`;
    await this.store.upload(storageKey, input.content, contentType);

    const [artifact] = await this.db('artifacts')
      .insert({
        sha256,
        storage_key: storageKey,
        content_type: contentType,
        // NULL: obtained by hand or by public-records request. The identical
        // row a scraped PDF produces, minus the URL there never was.
        source_url: null,
        byte_size: input.content.length,
        fetched_at: this.now(),
      })
      .returning<ArtifactRow[]>('*');

    if (input.requestId) await this.attachArtifact(input.requestId, artifact.id);

    const text = input.text ?? null;
    if (text === null || text.trim() === '') {
      // No text, no extraction. An empty extraction row would assert that we
      // looked and found nobody, which is not what happened.
      return { artifact, created: true, extraction: null, flagIds: [], namesAPerson: false };
    }

    const entities = extractEntities(text);
    const extraction = await this.storeExtraction(artifact.id, entities, null, null, null);

    const flags = detectRecordsFlags(text, entities);
    const flagIds: string[] = [];
    for (const flag of flags) {
      const [row] = await this.db('anomaly_flags')
        .insert({
          meeting_id: null,
          artifact_id: artifact.id,
          flag_type: flag.flag_type,
          description: flag.description,
          severity: flag.severity,
          metadata: JSON.stringify(flag.evidence),
          source: 'auto',
          // Held, always. A records-derived flag sits beside an extraction that
          // names people, and /api/anomalies is a public route. This is the
          // publication gate, and it is not conditional on what the extraction
          // happened to contain.
          review_state: 'held',
        })
        .returning<Array<{ id: string }>>('id');
      flagIds.push(row.id);
    }

    // B-a. Every flag written above is `held`, so each one is a queue entry —
    // created here rather than when someone next opens the console, so the
    // review window is measured from when the finding was raised.
    if (flagIds.length > 0) await ensureApprovalRequests(this.db);

    return {
      artifact,
      created: true,
      extraction,
      flagIds,
      namesAPerson: namesAPerson(entities),
    };
  }

  async attachArtifact(requestId: string, artifactId: string): Promise<void> {
    const request = await this.db('records_requests').where({ id: requestId }).first('id');
    if (!request) throw new RecordsError('Records request not found', 404);

    await this.db('records_request_artifacts')
      .insert({ request_id: requestId, artifact_id: artifactId })
      .onConflict(['request_id', 'artifact_id'])
      .ignore();
  }

  // ---- extraction --------------------------------------------------------

  /** The current extraction: the most recent row for the artifact. */
  async latestExtraction(artifactId: string): Promise<StoredExtraction | null> {
    const row = await this.db<StoredExtraction>('record_extractions')
      .where({ artifact_id: artifactId })
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .first();
    return row ?? null;
  }

  /** Every version, oldest first. Nothing is ever removed from this list. */
  async extractionHistory(artifactId: string): Promise<StoredExtraction[]> {
    return this.db<StoredExtraction>('record_extractions')
      .where({ artifact_id: artifactId })
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .select('*');
  }

  /**
   * Correct an extraction by appending a replacement that points at what it
   * replaces. Nothing is updated: what the machine originally said survives,
   * which is the point of an append-only path on a project whose subject is
   * the public record.
   */
  async correctExtraction(input: {
    artifactId: string;
    entities: ExtractedEntities;
    operatorId?: string | null;
    note?: string | null;
  }): Promise<StoredExtraction> {
    const artifact = await this.db('artifacts').where({ id: input.artifactId }).first('id');
    if (!artifact) throw new RecordsError('Document not found', 404);

    const previous = await this.latestExtraction(input.artifactId);
    return this.storeExtraction(
      input.artifactId,
      input.entities,
      previous?.id ?? null,
      input.operatorId ?? null,
      input.note ?? null,
    );
  }

  private async storeExtraction(
    artifactId: string,
    entities: ExtractedEntities,
    supersedesId: string | null,
    correctedBy: string | null,
    note: string | null,
  ): Promise<StoredExtraction> {
    const [row] = await this.db('record_extractions')
      .insert({
        artifact_id: artifactId,
        entities: JSON.stringify(entities),
        extractor_version: EXTRACTOR_VERSION,
        supersedes_id: supersedesId,
        corrected_by: correctedBy,
        note,
        created_at: this.now(),
      })
      .returning<StoredExtraction[]>('*');
    return row;
  }
}
