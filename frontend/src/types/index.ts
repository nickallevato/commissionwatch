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
  created_at: string;
  updated_at: string;
}

export interface MeetingDocument {
  id: string;
  meeting_id: string;
  title: string;
  document_type: string;
  url: string;
  created_at: string;
  updated_at: string;
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
  /** `term_start` is NOT NULL in the members table. */
  term_start: string;
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
  metadata: Record<string, unknown> | null;
  source: AnomalySource;
  created_at: string;
  meeting?: Meeting;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
}
