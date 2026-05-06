import { ParsedDocument } from '../parser/types';

export type AnomalyFlagType =
  | 'emergency_session'
  | 'closed_door_vote'
  | 'last_minute_agenda_change'
  | 'quorum_issue'
  | 'unanimous_controversial'
  | 'missing_minutes';

export type AnomalySeverity = 'critical' | 'high' | 'medium' | 'low';

export interface AnomalyFlag {
  flagType: AnomalyFlagType;
  severity: AnomalySeverity;
  description: string;
  metadata?: Record<string, unknown>;
}

export interface DetectionContext {
  meetingId: string;
  parsedDoc: ParsedDocument;
  scheduledDate?: string;
  publishedDate?: string;
  previousAgendaItems?: string[];
  minutesPublished?: boolean;
  meetingAge?: number;
}

export interface JurisdictionConfig {
  name: string;
  quorumSize: number;
  totalMembers: number;
  emergencyNoticeHours: number;
  minutesDeadlineDays: number;
  controversialTopics: string[];
}

export type Detector = (ctx: DetectionContext, config: JurisdictionConfig) => AnomalyFlag[];
