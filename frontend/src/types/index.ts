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

export type VoteValue = "yes" | "no" | "abstain" | "absent";
export type AnomalyFlagType = "emergency_session" | "closed_door_vote" | "last_minute_agenda_change" | "quorum_issue" | "unanimous_controversial" | "missing_minutes";
export type AnomalySeverity = "low" | "medium" | "high" | "critical";

export interface Member {
  id: string;
  jurisdiction_id: string;
  name: string;
  title: string | null;
  term_start: string;
  term_end: string | null;
  email: string | null;
  party: string | null;
  created_at: string;
  updated_at: string;
}

export interface Vote {
  id: string;
  meeting_id: string;
  agenda_item_id: string | null;
  member_id: string;
  vote: VoteValue;
  created_at: string;
  member?: Member;
}

export interface AnomalyFlag {
  id: string;
  meeting_id: string;
  flag_type: AnomalyFlagType;
  description: string;
  severity: AnomalySeverity;
  metadata: Record<string, unknown> | null;
  created_at: string;
}
