import { AnomalyFlag } from '../anomaly/types';
import { ExtractedAttendee, ExtractedMotion, ExtractedAgendaItem, ExtractedQuote } from '../parser/types';

export interface AttendanceSummary {
  present: string[];
  absent: string[];
  totalMembers: number;
  quorumMet: boolean;
}

export interface AgendaOutcome {
  itemNumber: number;
  title: string;
  category?: string;
  outcome: 'approved' | 'tabled' | 'deferred' | 'discussed' | 'no_action';
}

export interface VoteRecord {
  motion: string;
  mover?: string;
  seconder?: string;
  result?: 'passed' | 'failed' | 'tabled';
  tally: { yes: number; no: number; abstain: number; absent: number };
}

export interface RundownKeyItems {
  attendance: AttendanceSummary;
  agendaOutcomes: AgendaOutcome[];
  votes: VoteRecord[];
  keyQuotes: ExtractedQuote[];
  anomalies: AnomalyFlag[];
}

export interface RundownSheet {
  meetingId: string;
  summary: string;
  keyItems: RundownKeyItems;
  generatedAt: string;
}

export interface GenerateOptions {
  meetingId: string;
  jurisdiction?: string;
  anomalyFlags?: AnomalyFlag[];
}
