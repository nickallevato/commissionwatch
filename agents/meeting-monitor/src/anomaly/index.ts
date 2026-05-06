import { ParsedDocument } from '../parser/types';
import { AnomalyFlag, DetectionContext, JurisdictionConfig } from './types';
import { ALL_DETECTORS } from './detectors';
import { getJurisdictionConfig } from './config';
import { getDb } from '../db';

export { AnomalyFlag, AnomalyFlagType, AnomalySeverity, DetectionContext, JurisdictionConfig } from './types';
export { getJurisdictionConfig } from './config';
export { ALL_DETECTORS } from './detectors';

export interface DetectOptions {
  scheduledDate?: string;
  publishedDate?: string;
  previousAgendaItems?: string[];
  minutesPublished?: boolean;
  meetingAge?: number;
  jurisdiction?: string;
}

export function detectAnomalies(
  parsedDoc: ParsedDocument,
  meetingId: string,
  options: DetectOptions = {}
): AnomalyFlag[] {
  const config = getJurisdictionConfig(options.jurisdiction);
  const ctx: DetectionContext = {
    meetingId,
    parsedDoc,
    scheduledDate: options.scheduledDate,
    publishedDate: options.publishedDate,
    previousAgendaItems: options.previousAgendaItems,
    minutesPublished: options.minutesPublished,
    meetingAge: options.meetingAge,
  };

  const flags: AnomalyFlag[] = [];
  for (const detector of ALL_DETECTORS) {
    flags.push(...detector(ctx, config));
  }
  return flags;
}

export async function storeAnomalyFlags(meetingId: string, flags: AnomalyFlag[]): Promise<void> {
  if (flags.length === 0) return;
  const db = getDb();
  const rows = flags.map((f) => ({
    meeting_id: meetingId,
    flag_type: f.flagType,
    severity: f.severity,
    description: f.description,
    metadata: f.metadata ? JSON.stringify(f.metadata) : null,
  }));
  await db('anomaly_flags').insert(rows);
}
