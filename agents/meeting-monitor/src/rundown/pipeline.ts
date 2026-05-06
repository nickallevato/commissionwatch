import { parseDocument } from '../parser/parser';
import { ParsedDocument } from '../parser/types';
import { detectAnomalies, storeAnomalyFlags } from '../anomaly';
import { generateAndStoreRundown } from './index';
import { RundownSheet } from './types';
import { getDb } from '../db';

export interface PipelineInput {
  meetingId: string;
  documentPath: string;
  documentType?: 'pdf' | 'html';
  sourceUrl?: string;
  jurisdiction?: string;
}

export interface PipelineResult {
  meetingId: string;
  rundown: RundownSheet;
  anomalyCount: number;
}

export async function processDocument(input: PipelineInput): Promise<PipelineResult> {
  const parsedDoc = await parseDocument({
    input: input.documentPath,
    type: input.documentType,
    sourceUrl: input.sourceUrl,
  });

  const anomalyFlags = detectAnomalies(parsedDoc, input.meetingId, {
    jurisdiction: input.jurisdiction,
  });

  if (anomalyFlags.length > 0) {
    await storeAnomalyFlags(input.meetingId, anomalyFlags);
  }

  const rundown = await generateAndStoreRundown(parsedDoc, {
    meetingId: input.meetingId,
    jurisdiction: input.jurisdiction,
    anomalyFlags,
  });

  return {
    meetingId: input.meetingId,
    rundown,
    anomalyCount: anomalyFlags.length,
  };
}

export async function generateRundownFromParsed(
  parsedDoc: ParsedDocument,
  meetingId: string,
  jurisdiction?: string
): Promise<PipelineResult> {
  const anomalyFlags = detectAnomalies(parsedDoc, meetingId, { jurisdiction });

  if (anomalyFlags.length > 0) {
    await storeAnomalyFlags(meetingId, anomalyFlags);
  }

  const rundown = await generateAndStoreRundown(parsedDoc, {
    meetingId,
    jurisdiction,
    anomalyFlags,
  });

  return { meetingId, rundown, anomalyCount: anomalyFlags.length };
}
