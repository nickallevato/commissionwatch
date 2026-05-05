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

export type VoteValue = "yea" | "nay" | "abstain" | "absent";
export type AnomalyFlagType =
  | "unanimous_streak"
  | "quorum_risk"
  | "late_agenda_change"
  | "missing_minutes"
  | "unusual_vote_pattern"
  | "conflict_of_interest";
export type AnomalySeverity = "critical" | "high" | "medium" | "low";

export interface Member {
  id: string;
  jurisdiction_id: string;
  name: string;
  title: string | null;
  email: string | null;
  term_start: string | null;
  term_end: string | null;
  created_at: string;
  updated_at: string;
  jurisdiction?: Jurisdiction;
}

export interface Vote {
  id: string;
  meeting_id: string;
  agenda_item_id: string;
  member_id: string;
  value: VoteValue;
  created_at: string;
  updated_at: string;
  member?: Member;
}

export interface AnomalyFlag {
  id: string;
  meeting_id: string;
  flag_type: AnomalyFlagType;
  severity: AnomalySeverity;
  description: string;
  created_at: string;
  updated_at: string;
  meeting?: Meeting;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
}
