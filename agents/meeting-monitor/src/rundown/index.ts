import { ParsedDocument } from '../parser/types';
import { getDb } from '../db';
import { generateRundown } from './generator';
import { RundownSheet, GenerateOptions } from './types';

export { RundownSheet, RundownKeyItems, GenerateOptions, AttendanceSummary, AgendaOutcome, VoteRecord } from './types';
export { generateRundown } from './generator';

export async function generateAndStoreRundown(
  parsedDoc: ParsedDocument,
  options: GenerateOptions
): Promise<RundownSheet> {
  const rundown = generateRundown(parsedDoc, options);
  await storeRundown(rundown);
  return rundown;
}

export async function storeRundown(rundown: RundownSheet): Promise<void> {
  const db = getDb();
  const existing = await db('rundown_sheets').where({ meeting_id: rundown.meetingId }).first();

  const row = {
    meeting_id: rundown.meetingId,
    summary: rundown.summary,
    key_items: JSON.stringify(rundown.keyItems),
    generated_at: rundown.generatedAt,
  };

  if (existing) {
    await db('rundown_sheets').where({ meeting_id: rundown.meetingId }).update({
      ...row,
      updated_at: new Date().toISOString(),
    });
  } else {
    await db('rundown_sheets').insert(row);
  }
}

export async function getRundown(meetingId: string): Promise<RundownSheet | null> {
  const db = getDb();
  const row = await db('rundown_sheets').where({ meeting_id: meetingId }).first();
  if (!row) return null;

  return {
    meetingId: row.meeting_id,
    summary: row.summary,
    keyItems: typeof row.key_items === 'string' ? JSON.parse(row.key_items) : row.key_items,
    generatedAt: row.generated_at,
  };
}
