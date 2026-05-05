export type Confidence = 'high' | 'medium' | 'low';

export interface ConfidenceField<T> {
  value: T;
  confidence: Confidence;
}

export interface ExtractedAttendee {
  name: string;
  title?: string;
  present: boolean;
}

export interface ExtractedVote {
  memberName: string;
  vote: 'yes' | 'no' | 'abstain' | 'absent';
}

export interface ExtractedMotion {
  agendaItemNumber?: number;
  title: string;
  description?: string;
  mover?: string;
  seconder?: string;
  result?: 'passed' | 'failed' | 'tabled';
  votes: ExtractedVote[];
}

export interface ExtractedAgendaItem {
  itemNumber: number;
  title: string;
  description?: string;
  category?: string;
}

export interface ExtractedQuote {
  speaker: string;
  text: string;
  context?: string;
}

export interface ParsedDocument {
  meetingDate: ConfidenceField<string | null>;
  meetingTime: ConfidenceField<string | null>;
  attendees: ConfidenceField<ExtractedAttendee[]>;
  agendaItems: ConfidenceField<ExtractedAgendaItem[]>;
  motions: ConfidenceField<ExtractedMotion[]>;
  quotes: ConfidenceField<ExtractedQuote[]>;
  rawText: string;
  sourceType: 'pdf' | 'html';
  sourceUrl?: string;
}

export interface ParseOptions {
  input: string;
  type?: 'pdf' | 'html';
  sourceUrl?: string;
}
