import type { Knex } from 'knex';

const BOZEMAN_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const GALLATIN_ID = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const BOZEMAN_COMMISSION_ID = 'c3d4e5f6-a7b8-9012-cdef-123456789012';
const GALLATIN_COMMISSION_ID = 'd4e5f6a7-b8c9-0123-defa-234567890123';

const MEETINGS = {
  bozeman: [
    { id: 'e5f6a7b8-c9d0-1234-efab-345678901234', date: '2026-05-12', time: '18:00:00', location: 'City Hall Commission Room', status: 'scheduled' as const },
    { id: 'f6a7b8c9-d0e1-2345-fabc-456789012345', date: '2026-04-28', time: '18:00:00', location: 'City Hall Commission Room', status: 'completed' as const },
    { id: 'a7b8c9d0-e1f2-3456-abcd-567890123456', date: '2026-04-14', time: '18:00:00', location: 'City Hall Commission Room', status: 'completed' as const },
  ],
  gallatin: [
    { id: 'b8c9d0e1-f2a3-4567-bcde-678901234567', date: '2026-05-13', time: '09:00:00', location: 'Gallatin County Courthouse', status: 'scheduled' as const },
    { id: 'c9d0e1f2-a3b4-5678-cdef-789012345678', date: '2026-04-22', time: '09:00:00', location: 'Gallatin County Courthouse', status: 'completed' as const },
  ],
};

// DEVELOPMENT FIXTURES ONLY — every person below is fictional.
//
// This file previously named real, living Bozeman and Gallatin County
// officials and attached fabricated votes and anomaly flags to them. That is
// defamatory content sitting one `npm run seed` away from a public database,
// and an adversarial audit caught it before launch.
//
// The rule: seed data never names a real person. Real officials enter the
// database only through the ingestion pipeline, sourced from a stored
// artifact, with provenance. Fictional names make it obvious at a glance
// whether you are looking at seeded or ingested data.
const MEMBERS = {
  bozeman: [
    { id: 'd0e1f2a3-b4c5-6789-abcd-012345678901', name: 'Avery Sample', title: 'Mayor', jurisdiction_id: BOZEMAN_ID, term_start: '2024-01-01', term_end: '2027-12-31' },
    { id: 'e1f2a3b4-c5d6-7890-bcde-123456789012', name: 'Jordan Placeholder', title: 'Deputy Mayor', jurisdiction_id: BOZEMAN_ID, term_start: '2024-01-01', term_end: '2027-12-31' },
    { id: 'f2a3b4c5-d6e7-8901-cdef-234567890123', name: 'Riley Fixture', title: 'Commissioner', jurisdiction_id: BOZEMAN_ID, term_start: '2024-01-01', term_end: '2027-12-31' },
  ],
  gallatin: [
    { id: 'a3b4c5d6-e7f8-9012-defa-345678901234', name: 'Casey Example', title: 'Chair', jurisdiction_id: GALLATIN_ID, term_start: '2023-01-01', term_end: '2026-12-31' },
  ],
};

export async function seed(knex: Knex): Promise<void> {
  await knex('notifications').del();
  await knex('alert_subscriptions').del();
  await knex('votes').del();
  await knex('members').del();
  await knex('anomaly_flags').del();
  await knex('rundown_sheets').del();
  await knex('meeting_documents').del();
  await knex('agenda_items').del();
  await knex('meetings').del();
  await knex('commissions').del();
  await knex('jurisdictions').del();

  await knex('jurisdictions').insert([
    { id: BOZEMAN_ID, name: 'City of Bozeman', state: 'MT', type: 'city', website_url: 'https://www.bozemanmt.gov' },
    { id: GALLATIN_ID, name: 'Gallatin County', state: 'MT', type: 'county', website_url: 'https://www.gallatinmt.gov' },
  ]);

  await knex('commissions').insert([
    { id: BOZEMAN_COMMISSION_ID, jurisdiction_id: BOZEMAN_ID, name: 'Bozeman City Commission', description: 'Governing body for the City of Bozeman', meeting_schedule: '1st and 3rd Monday at 6:00 PM' },
    { id: GALLATIN_COMMISSION_ID, jurisdiction_id: GALLATIN_ID, name: 'Gallatin County Commission', description: 'Governing body for Gallatin County', meeting_schedule: 'Every Tuesday at 9:00 AM' },
  ]);

  // `published_at` is set explicitly. Seed data is a demonstration of the
  // *public* record, so a seeded meeting that sat unpublished would render the
  // seeded site empty — and would say the seed was broken when in fact it was
  // only undecided. Ingested meetings default to NULL; these are not ingested.
  const seededPublishedAt = new Date();
  await knex('meetings').insert([
    ...MEETINGS.bozeman.map((m) => ({
      ...m,
      commission_id: BOZEMAN_COMMISSION_ID,
      published_at: seededPublishedAt,
    })),
    ...MEETINGS.gallatin.map((m) => ({
      ...m,
      commission_id: GALLATIN_COMMISSION_ID,
      published_at: seededPublishedAt,
    })),
  ]);

  await knex('agenda_items').insert([
    { meeting_id: MEETINGS.bozeman[1].id, item_number: 1, title: 'Consent Agenda', category: 'consent' },
    { meeting_id: MEETINGS.bozeman[1].id, item_number: 2, title: 'Public Comment on Non-Agenda Items', category: 'public_comment' },
    { meeting_id: MEETINGS.bozeman[1].id, item_number: 3, title: 'Resolution 5432 - Water Infrastructure Bond', description: 'Approval of $12M bond for water system upgrades', category: 'action' },
    { meeting_id: MEETINGS.bozeman[2].id, item_number: 1, title: 'Consent Agenda', category: 'consent' },
    { meeting_id: MEETINGS.bozeman[2].id, item_number: 2, title: 'Ordinance 2108 - Zoning Amendment', description: 'Amendment to allow mixed-use in B-2 district', category: 'action' },
    { meeting_id: MEETINGS.gallatin[1].id, item_number: 1, title: 'Road Maintenance Contract Renewal', description: 'Renewal of county road maintenance contract for FY2027', category: 'action' },
    { meeting_id: MEETINGS.gallatin[1].id, item_number: 2, title: 'Budget Work Session', description: 'Preliminary FY2027 budget discussion', category: 'discussion' },
  ]);

  await knex('meeting_documents').insert([
    { meeting_id: MEETINGS.bozeman[0].id, title: 'May 12 Agenda Packet', document_type: 'agenda', url: 'https://example.invalid/seed/bozeman/2026-05-12/agenda.pdf' },
    { meeting_id: MEETINGS.bozeman[1].id, title: 'April 28 Agenda Packet', document_type: 'agenda', url: 'https://example.invalid/seed/bozeman/2026-04-28/agenda.pdf' },
    { meeting_id: MEETINGS.bozeman[1].id, title: 'April 28 Minutes', document_type: 'minutes', url: 'https://example.invalid/seed/bozeman/2026-04-28/minutes.pdf' },
    { meeting_id: MEETINGS.gallatin[1].id, title: 'April 22 Agenda', document_type: 'agenda', url: 'https://example.invalid/seed/gallatin/2026-04-22/agenda.pdf' },
    { meeting_id: MEETINGS.gallatin[1].id, title: 'April 22 Minutes', document_type: 'minutes', url: 'https://example.invalid/seed/gallatin/2026-04-22/minutes.pdf' },
  ]);

  await knex('members').insert([
    ...MEMBERS.bozeman,
    ...MEMBERS.gallatin,
  ]);

  // Insert votes for the completed April 28 Bozeman meeting (agenda item 3: Water Infrastructure Bond)
  const waterBondItemId = (await knex('agenda_items')
    .where({ meeting_id: MEETINGS.bozeman[1].id, item_number: 3 })
    .first())?.id;

  if (waterBondItemId) {
    await knex('votes').insert([
      { meeting_id: MEETINGS.bozeman[1].id, agenda_item_id: waterBondItemId, member_id: MEMBERS.bozeman[0].id, vote: 'yes' },
      { meeting_id: MEETINGS.bozeman[1].id, agenda_item_id: waterBondItemId, member_id: MEMBERS.bozeman[1].id, vote: 'yes' },
      { meeting_id: MEETINGS.bozeman[1].id, agenda_item_id: waterBondItemId, member_id: MEMBERS.bozeman[2].id, vote: 'no' },
    ]);
  }
}
