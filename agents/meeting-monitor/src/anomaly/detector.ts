import { parseDocument } from '../parser/parser';
import { detectAnomalies, storeAnomalyFlags } from './index';
import { getDb, closeDb } from '../db';

async function main() {
  const args = process.argv.slice(2);
  const meetingIdIdx = args.indexOf('--meeting-id');
  if (meetingIdIdx === -1 || !args[meetingIdIdx + 1]) {
    console.error('Usage: tsx src/anomaly/detector.ts --meeting-id <uuid>');
    process.exit(1);
  }

  const meetingId = args[meetingIdIdx + 1];
  const dryRun = args.includes('--dry-run');

  const db = getDb();
  const meeting = await db('meetings').where({ id: meetingId }).first();
  if (!meeting) {
    console.error(`Meeting not found: ${meetingId}`);
    await closeDb();
    process.exit(1);
  }

  const document = await db('documents').where({ meeting_id: meetingId }).orderBy('created_at', 'desc').first();
  if (!document) {
    console.error(`No document found for meeting: ${meetingId}`);
    await closeDb();
    process.exit(1);
  }

  const parsedDoc = await parseDocument({ input: document.file_path, type: document.doc_type });

  const scheduledDate = meeting.scheduled_at || meeting.meeting_date;
  const publishedDate = document.published_at || document.created_at;
  const meetingDate = new Date(meeting.meeting_date || meeting.scheduled_at);
  const meetingAge = Math.floor((Date.now() - meetingDate.getTime()) / (1000 * 60 * 60 * 24));

  const flags = detectAnomalies(parsedDoc, meetingId, {
    scheduledDate: scheduledDate?.toISOString?.() || scheduledDate,
    publishedDate: publishedDate?.toISOString?.() || publishedDate,
    meetingAge,
    minutesPublished: meeting.minutes_published ?? undefined,
  });

  console.log(`\nDetected ${flags.length} anomaly flag(s) for meeting ${meetingId}:\n`);
  for (const flag of flags) {
    console.log(`  [${flag.severity.toUpperCase()}] ${flag.flagType}: ${flag.description}`);
  }

  if (!dryRun && flags.length > 0) {
    await storeAnomalyFlags(meetingId, flags);
    console.log(`\nStored ${flags.length} flag(s) in database.`);
  } else if (dryRun) {
    console.log('\n(dry-run mode — flags not stored)');
  }

  await closeDb();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
