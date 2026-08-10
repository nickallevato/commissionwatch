export type JurisdictionType = "city" | "county";
export type MeetingStatus = "scheduled" | "completed" | "cancelled";

export interface Jurisdiction {
  id: string;
  name: string;
  state: string;
  type: JurisdictionType;
  website_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface Commission {
  id: string;
  jurisdiction_id: string;
  name: string;
  description: string | null;
  meeting_schedule: string | null;
  created_at: string;
  updated_at: string;
}

export interface Meeting {
  id: string;
  commission_id: string;
  date: string;
  time: string | null;
  location: string | null;
  status: MeetingStatus;
  agenda_url: string | null;
  minutes_url: string | null;
  /**
   * `meetings.published_at` — ingested and published are different states.
   *
   * Required, and `string | null`, because that is what the column is. The
   * public routes `SELECT *` and only ever return published rows, so in a
   * public payload this is always a timestamp; the operator payload carries
   * both states. Declaring it optional would let "absent" pass for
   * "unpublished", and those are not the same fact.
   */
  published_at: string | null;
  created_at: string;
  updated_at: string;
  commission?: Commission & { jurisdiction?: Jurisdiction };
}

export interface AgendaItem {
  id: string;
  meeting_id: string;
  item_number: number;
  title: string;
  description: string | null;
  category: string | null;
  /**
   * `agenda_items.field_confidence` — see {@link FieldConfidenceMap}.
   *
   * Required: the column is `NOT NULL DEFAULT '{}'` and the routes `SELECT *`,
   * so every agenda item carries a map. An empty one means no field was
   * assessed, which is not a claim that every field is sound.
   */
  field_confidence: FieldConfidenceMap;
  created_at: string;
  updated_at: string;
}

/** How sure the extractor is about one field. Never about a whole record. */
export type ConfidenceLevel = "high" | "medium" | "low";

export interface FieldConfidence {
  level: ConfidenceLevel;
  reason: string;
}

/**
 * Keyed by field name. Seven good agenda items and one mangled one is not a
 * low-confidence meeting, so there is no per-record score anywhere in this type.
 */
export type FieldConfidenceMap = Record<string, FieldConfidence>;

export interface MeetingDocument {
  id: string;
  meeting_id: string;
  title: string;
  document_type: string;
  url: string;
  created_at: string;
  updated_at: string;
}

/* -------------------------------------------- P5 · agenda diff timeline */

/**
 * One agenda item as extracted from one artifact, mirroring
 * `document_versions.item_snapshot`. Deliberately narrow: the description is
 * the part most likely to differ for formatting reasons alone.
 */
export interface VersionItem {
  item_number: number;
  title: string;
}

export type AgendaChangeKind = "added" | "removed" | "retitled";

export interface AgendaChange {
  kind: AgendaChangeKind;
  item_number: number;
  title: string;
  /** Present only on `retitled`. */
  previous_title?: string;
}

export interface DocumentVersionSummary {
  id: string;
  version_no: number;
  first_seen_at: string;
  sha256: string;
  byte_size: number;
  /**
   * `null` means the version was never extracted — a Word document, an artifact
   * backfilled from before version history existed. It is **not** zero items,
   * and the UI must never render it as one.
   */
  item_count: number | null;
}

export interface AgendaDiffPair {
  from: DocumentVersionSummary;
  to: DocumentVersionSummary;
  /** `null` when either side was never extracted, so no diff can be honest. */
  changes: AgendaChange[] | null;
  from_items: VersionItem[] | null;
  to_items: VersionItem[] | null;
}

export interface DocumentTimeline {
  document_id: string;
  title: string;
  document_type: string;
  url: string;
  versions: DocumentVersionSummary[];
  /** One entry per consecutive pair. Empty when the document has one version. */
  diffs: AgendaDiffPair[];
}

export interface RundownSheet {
  id: string;
  meeting_id: string;
  summary: string | null;
  key_items: RundownKeyItem[] | null;
  generated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RundownKeyItem {
  title: string;
  description: string;
  category?: string;
  priority?: "high" | "medium" | "low";
}

/** Postgres `vote_value` enum — see backend/migrations/010_create_votes.ts */
export type VoteValue = "yes" | "no" | "abstain" | "absent";

/** Postgres `anomaly_flag_type` enum — see backend/migrations/011_create_anomaly_flags.ts */
export type AnomalyFlagType =
  | "emergency_session"
  | "closed_door_vote"
  | "last_minute_agenda_change"
  | "quorum_issue"
  | "unanimous_controversial"
  | "missing_minutes";

/** Postgres `anomaly_severity` enum — see backend/migrations/011_create_anomaly_flags.ts */
export type AnomalySeverity = "critical" | "high" | "medium" | "low";

/** `anomaly_flags.source` — see backend/migrations/014_harden_anomaly_flags.ts */
export type AnomalySource = "auto" | "manual";

export interface Member {
  id: string;
  jurisdiction_id: string;
  name: string;
  title: string | null;
  email: string | null;
  /**
   * `term_start` is NOT NULL in the members table.
   *
   * Serialized as a full ISO 8601 timestamp, NOT "YYYY-MM-DD": the column is a
   * Postgres `date`, node-pg parses OID 1082 into a JS `Date`, and `res.json()`
   * stringifies that to e.g. "2023-01-15T00:00:00.000Z". Format for display
   * rather than slicing the string.
   */
  term_start: string;
  /** ISO 8601 timestamp — see the note on {@link Member.term_start}. */
  term_end: string | null;
  created_at: string;
  updated_at: string;
  jurisdiction?: Jurisdiction;
}

export interface Vote {
  id: string;
  meeting_id: string;
  /** Nullable: a vote can be recorded against a meeting with no agenda item. */
  agenda_item_id: string | null;
  member_id: string;
  /** The votes table stores the cast vote in a column named `vote`. */
  vote: VoteValue;
  created_at: string;
  member?: Member;
}

export interface AnomalyFlag {
  id: string;
  meeting_id: string;
  agenda_item_id: string | null;
  flag_type: AnomalyFlagType;
  severity: AnomalySeverity;
  description: string;
  /**
   * Only ever non-null when `source` is "manual". The detector inserts its
   * flags without a `metadata` value, so every "auto" row has `metadata: null`.
   */
  metadata: Record<string, unknown> | null;
  source: AnomalySource;
  created_at: string;
  meeting?: Meeting;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
}

/* ---------------------------------------------------------------------------
   Pressroom console — /api/admin/pressroom.
   Operator-only shapes. None of these is ever served to a public reader.
   --------------------------------------------------------------------------- */

/** `ingestion_runs.status`. `partial` is a success with a footnote, not a failure. */
export type IngestionRunStatus = "running" | "succeeded" | "partial" | "failed";

/** `ingestion_jobs.status`. */
export type IngestionJobStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "blocked";

export type SourceHealthStatus = "healthy" | "degraded" | "blocked";

/**
 * `unknown` when there is no `expected_interval_hours` or nothing has ever
 * succeeded — an absent expectation is not an expectation of zero.
 */
export type SilenceVerdict = "ok" | "suspect" | "unknown";

/** Precedence: disabled → never_run → failing → suspect → healthy. */
export type SourceVerdict =
  | "disabled"
  | "never_run"
  | "failing"
  | "suspect"
  | "healthy";

export interface IngestionRunSummary {
  id: string;
  status: IngestionRunStatus;
  started_at: string;
  finished_at: string | null;
  counts: Record<string, number>;
  error: string | null;
}

export interface SilenceWatch {
  verdict: SilenceVerdict;
  hours_since_success: number | null;
  expected_interval_hours: number | null;
}

export interface PressroomSource {
  id: string;
  adapter_key: string;
  enabled: boolean;
  /** Why a source is off, so the reason lives in the console and not a memory. */
  disabled_reason: string | null;
  health_status: SourceHealthStatus;
  cron_expression: string;
  expected_interval_hours: number | null;
  consecutive_failures: number;
  jurisdiction: { id: string; name: string; state: string };
  last_success_at: string | null;
  /** Summed across every run of the source. Zero is a failure state, not an empty table. */
  lifetime_records: number;
  silence: SilenceWatch;
  verdict: SourceVerdict;
  latest_run: IngestionRunSummary | null;
}

/** `202` from `POST /sources/:id/sweep`. The stack decides what `kind` means. */
export interface SweepOutcome {
  kind: string;
}

export interface RunFailure {
  id: string;
  stage: string;
  status: "failed" | "blocked";
  attempts: number;
  /** Rendered verbatim. A paraphrased error is a second bug to debug. */
  last_error: string | null;
  target: unknown;
  next_attempt_at: string;
}

export interface RunDetail {
  run: IngestionRunSummary & { source_id: string };
  source: { id: string; adapter_key: string; jurisdiction_name: string };
  jobs: {
    total: number;
    by_status: Record<IngestionJobStatus, number>;
    by_stage: Array<{ stage: string; status: string; count: number }>;
  };
  failures: RunFailure[];
  /** `headline` is the run status unchanged — `partial` stays `partial`. */
  outcome: {
    headline: IngestionRunStatus;
    records: number;
    failures: number;
  };
}

/** `202` from either re-parse route. Nothing is re-fetched from the source. */
export interface ReparseResult {
  run_id: string;
  enqueued: number;
}

export interface PressroomMeeting extends Meeting {
  external_id: string | null;
  published_at: string | null;
}

export interface PressroomAgendaItem extends AgendaItem {
  field_confidence: FieldConfidenceMap;
}

export interface StoredArtifact {
  id: string;
  sha256: string;
  storage_key: string;
  content_type: string | null;
  source_url: string | null;
  byte_size: number;
  fetched_at: string;
}

/** `record_corrections`. Append-only, enforced by a database trigger. */
export interface RecordCorrection {
  id: string;
  target_table: string;
  target_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  reason: string;
  operator_email: string | null;
  created_at: string;
}

export interface MeetingDetailPayload {
  meeting: PressroomMeeting;
  commission: { id: string; name: string };
  jurisdiction: { id: string; name: string; state: string };
  agenda_items: PressroomAgendaItem[];
  documents: MeetingDocument[];
  artifacts: StoredArtifact[];
  corrections: RecordCorrection[];
}

/** The tables a correction may target — mirrors the column's check constraint. */
export type CorrectionTargetTable =
  | "meetings"
  | "agenda_items"
  | "meeting_documents";
