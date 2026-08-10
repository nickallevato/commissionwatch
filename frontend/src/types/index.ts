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

// ---------------------------------------------------------------------------
// B-a · The findings review queue — `GET /api/admin/review/*`
// ---------------------------------------------------------------------------

/**
 * `approval_requests.status` — migration 038.
 *
 * There is deliberately no `expired`. A request past its window is overdue and
 * still pending; the flag stays held and nothing publishes. See the migration's
 * header for why a status written by a clock was refused.
 */
export type ReviewRequestStatus = "pending_review" | "approved" | "rejected";

/** How a citation was resolved. Most specific first, in that order. */
export type CitationKind = "flag_artifact" | "metadata_sha256" | "meeting_document";

/** One stored artifact a finding rests on. */
export interface FindingCitation {
  kind: CitationKind;
  artifact_id: string;
  sha256: string;
  storage_key: string;
  content_type: string | null;
  source_url: string | null;
  byte_size: number;
  fetched_at: string;
  document_title: string | null;
  document_type: string | null;
  version_no: number | null;
}

export interface ReviewQueueItem {
  request: {
    id: string;
    status: ReviewRequestStatus;
    severity: string;
    reviewer_operator_id: string | null;
    reviewer_email: string | null;
    review_comment: string | null;
    reviewed_at: string | null;
    expires_at: string;
    created_at: string;
    /** Derived at read time from `expires_at`. Never a stored status. */
    overdue: boolean;
  };
  finding: {
    id: string;
    flag_type: string;
    severity: string;
    description: string;
    review_state: string;
    source: string;
    meeting_id: string | null;
    agenda_item_id: string | null;
    artifact_id: string | null;
    metadata: Record<string, unknown> | null;
    created_at: string;
  };
  context: {
    meeting_date: string | null;
    meeting_published_at: string | null;
    commission_name: string | null;
    jurisdiction_name: string | null;
  };
  /** Empty means the finding cannot be approved. The API enforces it. */
  citations: FindingCitation[];
}

/** `review_policy` — B-b's replacement. One row, one threshold. */
export interface ReviewPolicy {
  id: string;
  hold_at_or_above: AnomalySeverity;
  review_window_hours: number;
  updated_by: string | null;
  updated_by_email: string | null;
  updated_at: string;
}

export interface ReviewQueueResponse {
  data: ReviewQueueItem[];
  total: number;
  policy: ReviewPolicy;
  counts: { pending: number; overdue: number; approved: number; rejected: number };
}

// ---------------------------------------------------------------------------
// P6 · Full-text search
// ---------------------------------------------------------------------------

/**
 * Mirrors `backend/src/services/search.ts`. Discriminated on `kind`, because
 * the four record types answer different questions and a flat shape would make
 * every renderer guess which fields are meaningful.
 */
export type SearchKind = "agenda_item" | "meeting" | "member" | "document";

interface SearchResultBase {
  kind: SearchKind;
  id: string;
  title: string;
  /**
   * The matching passage. Matches are wrapped in U+0002/U+0003 — control
   * characters, not markup — so the page marks them itself and never injects
   * server-supplied HTML from a scraped PDF.
   */
  snippet: string;
  rank: number;
}

export interface AgendaItemSearchResult extends SearchResultBase {
  kind: "agenda_item";
  meeting_id: string;
  meeting_date: string;
  commission_name: string;
  jurisdiction_name: string;
  item_number: number;
}

export interface MeetingSearchResult extends SearchResultBase {
  kind: "meeting";
  meeting_id: string;
  meeting_date: string;
  commission_name: string;
  jurisdiction_name: string;
}

export interface MemberSearchResult extends SearchResultBase {
  kind: "member";
  jurisdiction_name: string;
}

export interface DocumentSearchResult extends SearchResultBase {
  kind: "document";
  meeting_id: string;
  meeting_date: string;
  commission_name: string;
  jurisdiction_name: string;
  document_type: string;
  sha256: string;
}

export type SearchResult =
  | AgendaItemSearchResult
  | MeetingSearchResult
  | MemberSearchResult
  | DocumentSearchResult;

/** `/api/search` answers `{ data, total, query }` — not the bare list envelope. */
export interface SearchResponse {
  data: SearchResult[];
  total: number;
  query: string;
}

// ---------------------------------------------------------------------------
// The public status page — `GET /api/ingestion/sources`
// ---------------------------------------------------------------------------

/**
 * A run as a reader sees it: the figures, never the text.
 *
 * `PressroomSource.latest_run` carries the run's id and its raw error string.
 * Neither survives into the public projection — the error is free text written
 * by whatever threw and routinely quotes a document URL, and a run id opens
 * only a console route that 401s. `services/ingestion-status.ts` on the backend
 * is where that narrowing happens, and a test proves it.
 */
export interface PublicStatusRun {
  status: IngestionRunStatus;
  started_at: string;
  finished_at: string | null;
  records: number;
  failures: number;
}

export interface PublicStatusSource {
  adapter_key: string;
  jurisdiction: { name: string; state: string };
  enabled: boolean;
  disabled_reason: string | null;
  cron_expression: string;
  expected_interval_hours: number | null;
  last_success_at: string | null;
  lifetime_records: number;
  silence: SilenceWatch;
  verdict: SourceVerdict;
  latest_run: PublicStatusRun | null;
}

export interface PublicStatus {
  generated_at: string;
  last_successful_sweep_at: string | null;
  total: number;
  sources: PublicStatusSource[];
}

// ---------------------------------------------------------------------------
// B3 — the public corrections log and the dispute route
// ---------------------------------------------------------------------------

export type CorrectionRecordKind =
  | "meeting"
  | "agenda_item"
  | "document"
  | "finding";

/**
 * One row of `GET /api/corrections`.
 *
 * Deliberately narrower than the `record_corrections` row the console reads:
 * `operator_id` and `operator_email` are not in this shape because they are not
 * in the response. The accountable editor is named on the Methodology page; a
 * mailbox reprinted on every row adds nothing the masthead does not carry.
 *
 * `dispute_reference` is the reference and never the dispute's text — a dispute
 * is never published, and migration 039 permits one value of its `review_state`.
 */
export interface PublicCorrection {
  id: string;
  created_at: string;
  record_kind: CorrectionRecordKind;
  record_label: string;
  meeting_id: string | null;
  field: string;
  field_label: string;
  old_value: string | null;
  new_value: string | null;
  reason: string;
  dispute_reference: string | null;
  summary: string;
}

export interface PublicCorrectionResponse {
  data: PublicCorrection[];
  total: number;
}

/** What `POST /api/corrections/disputes` hands back. There is no email. */
export interface DisputeReceipt {
  reference: string;
  status: DisputeStatus;
  received_at: string;
}

export type DisputeStatus = "received" | "upheld" | "declined";

export type DisputableTable =
  | "meetings"
  | "agenda_items"
  | "meeting_documents"
  | "anomaly_flags";

/** The operator's view. There is no public route that returns this shape. */
export interface DisputeRecord {
  id: string;
  reference: string;
  target_table: string;
  target_id: string;
  contested: string;
  account: string;
  contact: string;
  status: DisputeStatus;
  review_state: string;
  reviewer_operator_id: string | null;
  reviewer_email: string | null;
  review_reason: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DisputeContext {
  meeting_id: string | null;
  meeting_date: string | null;
  commission_name: string | null;
  jurisdiction_name: string | null;
  record_summary: string;
}

export interface DisputeItem {
  dispute: DisputeRecord;
  context: DisputeContext;
}

export interface DisputeListing {
  data: DisputeItem[];
  total: number;
  counts: { received: number; upheld: number; declined: number };
}

/* ---------------------------------------------------------------------------
   Officials as first-class subjects — `GET /api/officials/:id`.

   Mirrors `backend/src/services/officials.ts`. Everything here is already
   filtered to published records on the server; the page does not re-filter and
   must not be written as though it could.
   --------------------------------------------------------------------------- */

export interface OfficialVotingRecord {
  yes: number;
  no: number;
  abstain: number;
  absent: number;
  total: number;
}

export interface OfficialAttendance {
  /** Published meetings where this official has at least one recorded vote. */
  meetingsWithRollCall: number;
  present: number;
  absent: number;
  /** `null` when there is no roll call. Never render a null as 0. */
  rate: number | null;
}

export interface OfficialAlignment {
  comparableVotes: number;
  withMajority: number;
  /** `null` when nothing is comparable — not the same fact as 0. */
  rate: number | null;
}

/** `YYYY-MM`. Every month in the window is present, including empty ones. */
export interface OfficialActivityMonth {
  month: string;
  votes: number;
}

export interface OfficialTimelineEntry {
  meeting_id: string;
  /** `YYYY-MM-DD` — narrowed by the service, unlike the raw date columns. */
  date: string;
  commission_name: string;
  location: string | null;
  record: OfficialVotingRecord;
  dissents: number;
}

/**
 * How confident a name match is. There is deliberately no band above
 * `strong` — see `backend/src/services/finance/name-match.ts`. A UI that added
 * one would be asserting an identity the matcher cannot establish.
 */
export type NameMatchBand = "weak" | "moderate" | "strong";

export interface StoredNameMatch {
  method: "distinctive_term_overlap";
  band: NameMatchBand;
  score: number;
  matchedTerms: string[];
  unmatchedTerms: string[];
  /** Terms the matcher was blind to — entity class, jurisdiction, procedure. */
  discardedTerms: string[];
}

export interface CitedContribution {
  contributionId: string;
  sourceSystem: string;
  donorName: string;
  recipientName: string;
  committeeName: string | null;
  amount: number;
  contributionDate: string;
  externalId: string | null;
  imageNumber: string | null;
  /** The API request that returned it, credential stripped. */
  sourceUrl: string;
  /** A page a reader can open, when the filing system publishes one. */
  documentUrl: string | null;
}

export interface VoteDonorEvidence {
  memberId: string;
  memberName: string;
  voteId: string;
  votePosition: string;
  agendaItemId: string;
  agendaItemNumber: number;
  agendaItemTitle: string;
  donorName: string;
  contributionCount: number;
  totalAmount: number;
  earliestContributionDate: string;
  latestContributionDate: string;
  donorMatch: StoredNameMatch;
  recipientMatch: StoredNameMatch;
  contributions: CitedContribution[];
  coverageNote: string;
}

export interface OfficialFinding {
  id: string;
  meeting_id: string | null;
  flag_type: string;
  severity: string;
  description: string;
  created_at: string;
  /** Present only on a `vote_donor_conflict` whose metadata parses. */
  evidence: VoteDonorEvidence | null;
}

export interface FinanceSystem {
  key: string;
  name: string;
  scope: string;
  state: "active" | "planned";
  url: string;
}

export interface FinanceCoverage {
  systems: FinanceSystem[];
  federalOnly: boolean;
  /** The sentence. Rendered verbatim — never paraphrased in a component. */
  caveat: string;
}

export interface OfficialProfile {
  /**
   * The `members` row, plus the narrowed jurisdiction the service selects.
   *
   * `Omit` rather than an intersection: `Member.jurisdiction` is the full
   * `Jurisdiction` the roster endpoint embeds, and `/api/officials/:id`
   * deliberately selects three columns. Intersecting the two would produce a
   * type nothing on the wire can satisfy.
   */
  official: Omit<Member, "jurisdiction"> & {
    jurisdiction: { id: string; name: string; state: string } | null;
    /**
     * `members.party` is a real, nullable column that `Member` above has never
     * declared. It is named here rather than added there because widening the
     * roster type is a change every existing fixture would have to answer for,
     * and this endpoint is the only one that reads it.
     */
    party: string | null;
  };
  record: OfficialVotingRecord;
  attendance: OfficialAttendance;
  alignment: OfficialAlignment;
  activity: OfficialActivityMonth[];
  timeline: OfficialTimelineEntry[];
  findings: OfficialFinding[];
  finance: FinanceCoverage;
}

// ---------------------------------------------------------------------------
// The bulk export — `GET /api/data`
// ---------------------------------------------------------------------------

/** One licence layer as the manifest states it. Three layers, never conflated. */
export interface DataLicenseLayer {
  name: string;
  url: string | null;
  covers: string;
}

/**
 * One exported table, as the API describes itself.
 *
 * `provenance` is null where the schema records no source artifact for the
 * rows — `members`, `jurisdictions`, `commissions`. `/data` renders that
 * absence in words rather than as a blank cell, because a blank reads as a
 * lost source and the truth is that there never was one.
 */
export interface DataManifestDataset {
  name: string;
  description: string;
  provenance: string | null;
  columns: string[];
  row_count: number;
  json_url: string;
  csv_url: string;
}

export interface DataManifest {
  generated_at: string;
  schema_migration: string | null;
  attribution: string;
  license: {
    dataset: DataLicenseLayer & { attribution: string };
    code: DataLicenseLayer;
    documents: DataLicenseLayer;
  };
  republication_request: string;
  publication_rule: string;
  datasets: DataManifestDataset[];
}

// ---------------------------------------------------------------------------
// The public calendar — `GET /api/calendar`
// ---------------------------------------------------------------------------

/**
 * One meeting on the calendar.
 *
 * `time` is null wherever the source publishes no start time, which is most
 * rows: Granicus states one for upcoming meetings only. It is never zero and
 * never midnight — `meetings` holds a DATE and a nullable TIME, and a null
 * there means the record does not say.
 */
export interface CalendarMeetingSummary {
  id: string;
  date: string;
  time: string | null;
  body_name: string;
  location: string | null;
  status: MeetingStatus;
}

export interface CalendarJurisdiction {
  id: string;
  name: string;
  state: string;
  timezone: string;
  /** The subscribable iCal feed for this jurisdiction. */
  ics_url: string;
  upcoming: CalendarMeetingSummary[];
  recent: CalendarMeetingSummary[];
}

export interface CalendarResponse {
  data: CalendarJurisdiction[];
  total: number;
}
