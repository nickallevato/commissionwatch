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

/* --------------------------------------------------------------- matters */

/**
 * A matter is a subject of decision — a rezone, an ordinance, a capital
 * project — followed across every meeting that touched it.
 *
 * **`state` is derived by the API at read time and is never a stored column.**
 * The same reasoning migration 038 gives for `overdue`: a terminal status set
 * by a clock is indistinguishable, in the log, from a decision a person made.
 * So the frontend must not cache it as though it were a fact about the row, and
 * must not compute a competing version of it.
 */
export type MatterState = "pending" | "decided" | "withdrawn" | "dormant";

export interface Matter {
  id: string;
  /** As first seen in the record, verbatim. */
  title: string;
  /** "Ordinance 2145" and the like. Null when identity came from the title. */
  designator: string | null;
  state: MatterState;
  /** ISO date. Earliest *published* appearance. */
  first_seen: string;
  /** ISO date. Latest *published* appearance. */
  last_seen: string;
  /** Published appearances only, so it agrees with the list below it. */
  appearance_count: number;
  jurisdiction_name: string;
  commission_name: string;
}

/**
 * One agenda item, at one meeting, that concerns this matter.
 *
 * `title` is the title as printed at *that* meeting and may differ from the
 * matter's — a body renaming an item between readings is exactly the kind of
 * thing this page exists to make visible, so the per-appearance title is shown
 * rather than normalised away.
 *
 * `match_rule` is the basis of the join, carried so a reader can see *why* two
 * agenda items were treated as the same matter. There is no fuzzy rule: a
 * near-match would be an inference, and inferences are not published here.
 */
export interface MatterAppearance {
  agenda_item_id: string;
  meeting_id: string;
  meeting_date: string;
  item_number: number;
  title: string;
  match_rule: "designator" | "normalized_title";
}

export interface MatterDetail extends Matter {
  /** Ascending by meeting date — a timeline reads forwards. */
  appearances: MatterAppearance[];
}

/* --------------------------------------------------------------- metrics */

/**
 * This project's own numbers — see `backend/src/services/metrics.ts`.
 *
 * Every field is a count or a duration. There are no identifiers here by
 * design: an aggregate says how much is withheld without saying which record,
 * which is what keeps `/metrics` on the right side of the publication wall.
 */
export interface CorpusMetrics {
  meetings_total: number;
  meetings_published: number;
  agenda_items: number;
  documents_indexed: number;
  documents_total: number;
  votes: number;
  matters: number;
}

export interface ReviewMetrics {
  findings_total: number;
  findings_published: number;
  findings_held: number;
  claims_total: number;
  claims_approved: number;
  disputes_received: number;
  disputes_resolved: number;
}

export interface LatencyMetrics {
  /** Null means nothing has ever been published — never render it as 0. */
  median_days_to_publish: number | null;
  last_published_at: string | null;
}

/**
 * How well the record was *read*, as opposed to how much of it there is.
 *
 * `roster_sourced` is false and is meant to be shown as false: `members`
 * carries no provenance columns, so no row can prove where it came from.
 */
export interface QualityMetrics {
  vote_events_total: number;
  vote_events_approved: number;
  roster_unmatched: number;
  roster_seats_sourced: number;
  roster_seats_implied: number;
  roster_sourced: boolean;
}

export interface Metrics {
  corpus: CorpusMetrics;
  quality: QualityMetrics;
  review: ReviewMetrics;
  latency: LatencyMetrics;
  generated_at: string;
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
  /**
   * Did a named operator approve this, or was it published by rule?
   *
   * `review_state = 'published'` says a finding is public. It does not say
   * anybody read it: `resolveReviewState` holds a flag only when a detector
   * marked it `alwaysHold` — which is what "nothing naming a person
   * auto-publishes" is made of — or when its severity reaches the review
   * threshold, `high` by default. A low or medium flag naming nobody is
   * published with no human in the loop.
   *
   * Optional because older responses do not carry it, and `undefined` must stay
   * distinguishable from `false`: "we do not know" and "nobody approved this"
   * are different statements and only one of them should be printed.
   */
  operator_reviewed?: boolean;
  /** The approval's own timestamp, never the row's `updated_at`. Null when unreviewed. */
  reviewed_at?: string | null;
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
  /**
   * The dispute that prompted this correction, if one did — `record_corrections.dispute_id`,
   * migration 039. It is the id and never the dispute's text: a dispute is
   * never published, and the console renders the link, not the contest.
   */
  dispute_id: string | null;
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
  /** Whether the parser has read these bytes — not the same as what it found. */
  parse: MeetingParseStatus;
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
  /**
   * The stored name match, parsed server-side by the same
   * `parseVoteDonorEvidence` the public API uses. `null` for a finding that is
   * not a name-match finding, or whose metadata does not parse.
   */
  evidence: VoteDonorEvidence | null;
  /**
   * The judgement in force on this finding's donor/subject pair **now** — which
   * is not necessarily the one inside `evidence`, which is frozen at the moment
   * the finding was raised.
   */
  entity_decision: StoredEntityDecision | null;
}

/** How the queue is ordered. Mirrors `QueueSort` in the review service. */
export type ReviewQueueSort = "default" | "weakest_first";

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
  /** Served rather than restated in the console. See `MatchPolicy`. */
  match_policy: MatchPolicy;
  /** Pending findings by stored band, so the shape of the queue is visible. */
  band_counts: Record<NameMatchBand | "unbanded", number>;
}

// ---------------------------------------------------------------------------
// P6 · Full-text search
// ---------------------------------------------------------------------------

/**
 * Mirrors `backend/src/services/search.ts`. Discriminated on `kind`, because
 * the four record types answer different questions and a flat shape would make
 * every renderer guess which fields are meaningful.
 */
export type SearchKind =
  | "agenda_item"
  | "meeting"
  | "member"
  | "document"
  | "finding"
  | "matter";

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

/**
 * A detected pattern, held for review and approved by a person.
 *
 * `meeting_id` is nullable, and that is the schema rather than a convenience: a
 * records-derived finding is about an artifact and has no meeting. A link
 * builder that assumes one produces `/meetings/null`.
 */
export interface FindingSearchResult extends SearchResultBase {
  kind: "finding";
  flag_type: string;
  severity: string;
  meeting_id: string | null;
}

/** A subject of decision, followed across the meetings that touched it. */
export interface MatterSearchResult extends SearchResultBase {
  kind: "matter";
  /** `null` when the identity came from the title. Display, never the key. */
  designator: string | null;
  commission_name: string;
  jurisdiction_name: string;
}

export type SearchResult =
  | AgendaItemSearchResult
  | MeetingSearchResult
  | MemberSearchResult
  | DocumentSearchResult
  | FindingSearchResult
  | MatterSearchResult;

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
  /**
   * The operator judgement in force when this finding was raised, frozen onto
   * it. `null` when the pair had never been judged. Mirrors
   * `backend/src/services/finance/evidence.ts`.
   */
  operatorEntityDecision: StoredEntityDecision | null;
}

/**
 * An operator's answer to the one question the matcher cannot answer.
 *
 * Only `same_entity` ever reaches a finding: a `different_entity` judgement
 * suppresses the finding, so there is none for it to be attached to.
 */
export interface StoredEntityDecision {
  decision: "same_entity";
  donorNameFiled: string;
  subjectTerms: string;
  reason: string;
  operatorEmail: string | null;
  decidedAt: string;
}

export type EntityResolutionDecision = "same_entity" | "different_entity";

/**
 * `MATCH_POLICY` from `backend/src/services/finance/correlation.ts`.
 *
 * `statement` is rendered verbatim rather than restated in a component, so the
 * policy on the screen and the policy the detector enforces cannot drift into
 * disagreeing.
 */
export interface MatchPolicy {
  minimumBand: NameMatchBand;
  bands: Array<{ band: NameMatchBand; label: string }>;
  statement: string;
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

/**
 * One ingested meeting as the console lists it, published or not.
 *
 * The public API cannot return an unpublished meeting at all — decision 8 — so
 * this shape exists only behind `requireOperator`. `published_at` being null is
 * the whole point of the screen it feeds: it is the backlog awaiting a human.
 */
export interface PressroomMeetingSummary {
  id: string;
  /** A calendar day, `YYYY-MM-DD`, never an instant. */
  date: string;
  time: string | null;
  status: string;
  location: string | null;
  external_id: string | null;
  agenda_url: string | null;
  minutes_url: string | null;
  published_at: string | null;
  commission: { id: string; name: string };
  document_count: number;
}

export interface PressroomMeetingList {
  meetings: PressroomMeetingSummary[];
  /** The whole unpublished backlog, not just what fitted on this page. */
  unpublished_total: number;
  total: number;
}

export interface BulkPublishResult {
  published: string[];
  already_published: string[];
  not_found: string[];
}

/** Whether the parser has actually been asked about a meeting's stored bytes. */
export type ParseState = "no_document" | "not_run" | "running" | "done" | "failed";

export interface MeetingParseStatus {
  state: ParseState;
  total: number;
  done: number;
  outstanding: number;
  failed: number;
  last_error: string | null;
}

// ---------------------------------------------------------------------------
// The source viewer — `GET /api/source/:sha256`
// ---------------------------------------------------------------------------

/**
 * A window onto a stored document, at its content address.
 *
 * Mirrors `SourceWindow` in `backend/src/services/source-viewer.ts` field for
 * field. Two of them are easy to misread and the backend's header says why:
 *
 * - `source_url` is **where we fetched it**, not the address. The county
 *   reorganises its site; the bytes do not. Rendering it as the citation would
 *   make every citation rot on their schedule.
 * - `text` is a slice. `window_start` is its offset in the whole document, so
 *   an in-document position becomes an in-window one by subtracting it, and
 *   `truncated` must be said out loud — a reader who thinks a 2,000-character
 *   window is the document has been misled by omission.
 *
 * The text was extracted from third-party PDFs and county HTML. It is rendered
 * as React text nodes and never as markup.
 */
export interface SourceWindow {
  sha256: string;
  content_type: string | null;
  byte_size: number;
  source_url: string | null;
  fetched_at: string | null;
  char_count: number;
  text: string;
  window_start: number;
  window_end: number;
  truncated: boolean;
  source_label: string;
}

// ---------------------------------------------------------------------------
// Claims — `GET /api/admin/claims/*` and `GET /api/meetings/:id/claims`
// ---------------------------------------------------------------------------

/**
 * Mirrors `backend/src/services/review/claims.ts` field for field. Two halves,
 * and they are not interchangeable: everything above `PublicClaimCard` is what
 * an operator sees while deciding, and everything below it is what a reader
 * sees afterwards. The operator's half carries the triple, the status and the
 * refusals; the reader's half carries a sentence and a quote and nothing else,
 * because a reader is not being asked to make a decision.
 */

/** `minute_claims.status`, minus the states the queue does not filter on. */
export type ClaimQueueStatus = "held" | "approved" | "rejected";

/**
 * The ±500 characters an operator reads the quote inside.
 *
 * `quote_start`/`quote_end` index `text`, not the document — the window has
 * already been sliced. `offset_matches_stored` false means the span below was
 * located by searching rather than by trusting `quote_offset`, and the screen
 * says so rather than implying a precision it does not have.
 */
export interface ClaimQuoteContext {
  text: string;
  quote_start: number;
  quote_end: number;
  window_offset: number;
  offset_matches_stored: boolean;
}

export interface ClaimCitation {
  artifact_sha256: string;
  quote_offset: number;
  quote: string;
  /** Where we got the bytes. Null when no artifact holds this address. */
  source_url: string | null;
  /** Whether the cited bytes are stored. False blocks approval. */
  artifact_stored: boolean;
  viewer_path: string;
  context: ClaimQuoteContext | null;
}

/**
 * The pin, as the backend reports it. `awaiting_re_review` means the sentence
 * this build renders is not the sentence that was approved, so nothing renders
 * — not the stored text either.
 */
export type ClaimRenderState =
  | { state: "renderable"; text: string }
  | { state: "awaiting_re_review"; reason: string };

/** `claim_verdicts.confidence`. Mirrors migration 093's CHECK. */
export type GovernorConfidence = "low" | "medium" | "high";

/**
 * A span of the governor's window, located by the backend rather than supplied
 * by the model — `services/governor/verdict.ts` refuses a reply whose cited
 * wording it cannot find in the bytes. The offsets index the ±2,000-character
 * judged window, which this API does not serve, so nothing on the review screen
 * draws them; `window_sha256` is what identifies the text they belong to.
 */
export interface GovernorReliedSpan {
  start: number;
  end: number;
}

/**
 * The second model's verdict on one attribution.
 *
 * `verify.ts` already proves the quote is in the document and names the subject.
 * What it cannot decide is which of two names in one sentence a verb attaches
 * to, and that is the only question this answers.
 *
 * It approves nothing. There is no path from a verdict to `status = 'approved'`
 * and `render.approvable` does not consult it — a verdict changes the order and
 * the annotation of human review and nothing else. `state` is the store's own
 * label: `governor_rejected` is not a claim status.
 */
export interface ClaimGovernorVerdict {
  state: "supported" | "governor_rejected";
  supported: boolean;
  /**
   * What the window does not support, in the judge's words. Free text, not
   * offsets: the prompt asks it to name "the person, the action, or the matter"
   * in a few words, so a fragment is sometimes the claim's wording and sometimes
   * a description of it. See `components/ui/governor-quote.ts`.
   */
  unsupported_fragments: string[];
  relied_on: GovernorReliedSpan[];
  confidence: GovernorConfidence;
  /** The model that answered, and the instructions it answered under. */
  model: string;
  prompt_version: string;
  /** The exact bytes judged. A verdict whose window no longer matches is stale. */
  window_sha256: string;
  created_at: string;
}

export interface ClaimReviewItem {
  claim: {
    id: string;
    meeting_id: string;
    subject_name: string;
    member_id: string | null;
    action: string;
    matter: string | null;
    status: string;
    model: string;
    prompt_version: string;
    reviewed_by: string | null;
    review_reason: string | null;
    reviewed_at: string | null;
    approved_by: string | null;
    approved_at: string | null;
    rendered_text: string | null;
    render_sha256: string | null;
    render_version: string | null;
    retracted_at: string | null;
    retracted_reason: string | null;
    created_at: string;
    /** Derived from the review window. Never a stored column. */
    overdue: boolean;
  };
  /**
   * The exact sentence that would publish, rendered by the backend code the
   * public page uses. The console renders `render.text` and never assembles a
   * sentence from the triple — approval pins these bytes, and a screen that
   * showed its own version of them would be asking for an approval of
   * something else.
   */
  render: {
    text: string | null;
    sha256: string | null;
    version: string;
    motive_terms: string[];
    approvable: boolean;
    blocked_reason: string | null;
    pin: ClaimRenderState | null;
  };
  /**
   * The second model's opinion, or the absence of one.
   *
   * `null` is a third state — *not checked* — and the screen must say so. An API
   * that was down, a rate limit, and a reply that parsed to nothing all land
   * here, and none of them is a pass. Rendering it as a blank would let the one
   * claim nobody could check look exactly like the ones that were checked and
   * passed.
   */
  governor: ClaimGovernorVerdict | null;
  citation: ClaimCitation;
  context: {
    meeting_date: string | null;
    meeting_published_at: string | null;
    commission_name: string | null;
    jurisdiction_name: string | null;
  };
}

export interface ClaimQueueResponse {
  data: ClaimReviewItem[];
  total: number;
  counts: {
    held: number;
    approved: number;
    rejected: number;
    retracted: number;
    overdue: number;
    /**
     * Held claims the governor has never judged. On the counts row because a
     * silently growing backlog looks identical to a system with nothing to
     * judge: a governor that has stopped running produces no error and no
     * missing page, only this number climbing.
     */
    governor_unjudged: number;
  };
}

/** One published claim. Six parts and no seventh. */
export interface PublicClaimCard {
  id: string;
  /** `claim-{id}`. Stable across re-renders because the id is. */
  anchor: string;
  text: string;
  quote: string;
  artifact_sha256: string;
  quote_offset: number;
  source_path: string;
  approved_at: string | null;
  model: string;
  prompt_version: string;
}

/**
 * A withdrawn claim, at the anchor it was published at.
 *
 * It renders. The sentence is in caches and feeds, and a reader arriving from
 * one needs a page saying *that sentence was wrong* rather than a page showing
 * nothing while the cached version stays the only version they ever see.
 */
export interface PublicClaimTombstone {
  id: string;
  anchor: string;
  retracted_at: string;
  retracted_reason: string;
  previous_text: string | null;
}

export interface PublicClaims {
  claims: PublicClaimCard[];
  tombstones: PublicClaimTombstone[];
  /**
   * Approved claims whose pin no longer holds — a count, not the claims. The
   * page says one is being withheld and shows nothing, because the whole point
   * of the pin is that this text does not go out.
   */
  awaiting_re_review: number;
}

// ---------------------------------------------------------------------------
// Transcripts — `GET /api/transcripts/coverage`
// ---------------------------------------------------------------------------

/**
 * The kinds an adapter can put in `meeting_documents.document_type`, mirroring
 * `backend/src/services/ingestion/adapters/types.ts`.
 *
 * Held here so a page that makes a claim about document kinds can be checked
 * against the whole set rather than against whichever three the author
 * remembered. The search disclosure is the reason it exists: it named agendas
 * as the only indexed kind for months after minutes and transcripts were
 * indexed too.
 */
export const DOCUMENT_KINDS = [
  "agenda",
  "minutes",
  "packet",
  "resolution",
  "ordinance",
  "attachment",
  "transcript",
  "other",
] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/**
 * One body's transcript record for one calendar year, mirroring
 * `TranscriptCoverageRow` in `backend/src/services/transcript-coverage.ts`.
 *
 * Four counts, and they must stay four. `absent` is the custodian serving a
 * well-formed caption file with nothing in it — a fact about their record, and
 * era-shaped rather than random. `unavailable` is us failing to get an answer.
 * `unchecked` is a meeting we have not asked about yet, and dropping it would
 * let a body with two hundred unswept meetings render as fully covered.
 * Summing any two of them publishes one party's silence as another's.
 */
export interface TranscriptCoverageRow {
  jurisdiction: string;
  body: string;
  year: number;
  published: number;
  absent: number;
  unavailable: number;
  unchecked: number;
  /** Most recent check in this group, ISO 8601, or null if nothing was checked. */
  checked_through: string | null;
}

export interface TranscriptCoverageResponse {
  coverage: TranscriptCoverageRow[];
}

/**
 * The four things that can be true of one transcript document, mirroring
 * `MEETING_TRANSCRIPT_STATES` in `backend/src/services/transcript-coverage.ts`.
 *
 * `unchecked` is not a `transcript_status` state — that table has three. It is
 * the *absence* of a row, given the same name the coverage query gives it, so a
 * reader who has seen the coverage page does not have to learn a second set of
 * words for the same four facts.
 */
export type MeetingTranscriptState =
  | "published"
  | "absent"
  | "unavailable"
  | "unchecked";

/**
 * What we know about one transcript document, mirroring
 * `MeetingTranscriptDocument` in `backend/src/services/transcript-coverage.ts`.
 *
 * One entry per document, never per meeting: Bozeman's archive files a single
 * sitting as two rows ("City Commission Meeting pt 1") each with its own clip,
 * and a meeting whose first half published and whose second half we could not
 * fetch is two statements. A scalar would have to pick one of them to tell.
 */
export interface MeetingTranscriptDocument {
  meeting_document_id: string;
  /** The custodian's own identifier for the recording. Null when unchecked. */
  clip_id: string | null;
  state: MeetingTranscriptState;
  /**
   * Cues indexed for this document — what a citation could resolve against.
   *
   * Zero for `absent`, and that zero is a fact: the custodian served a
   * well-formed caption file with nothing in it. **Null for `unavailable` and
   * `unchecked`**, where we do not know, and rendering either as 0 would
   * publish our silence as theirs.
   */
  cue_count: number | null;
  /**
   * The bytes we read, so an absence claim is checkable with one command.
   *
   * Not a link to `/source/{sha}`: migration 089 deliberately made this **not**
   * a foreign key to `artifacts`, because the row records which bytes were
   * served on a date and must survive the artifact never having been stored.
   * The source viewer would 404 on a hash that is nonetheless true.
   */
  observed_sha256: string | null;
  last_checked_at: string | null;
}

/**
 * `GET /api/meetings/:id` → `transcript`, mirroring `MeetingTranscript` in
 * `backend/src/services/transcript-coverage.ts`. Named `…Summary` here only
 * because `MeetingTranscript` is already the component that renders it.
 *
 * The route answers `null` when the meeting has no transcript document at all,
 * and that is a **fifth** state rather than a fourth: `unchecked` says there is
 * a document we never asked about, `null` says there is nothing to ask about.
 */
export interface MeetingTranscriptSummary {
  documents: MeetingTranscriptDocument[];
  published: number;
  absent: number;
  unavailable: number;
  unchecked: number;
  /** Most recent check across this meeting's documents, or null. */
  checked_through: string | null;
}
