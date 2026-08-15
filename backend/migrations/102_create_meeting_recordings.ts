import type { Knex } from 'knex';

/**
 * What the custodian published as a *recording* of one meeting, and how long it is.
 *
 * ## Why this table exists instead of a transcription pipeline
 *
 * The audio spec of 2026-08-14 asked for extracted audio, self-hosted ASR and a
 * reproducibility manifest. Probed 2026-08-15, before any of it was written:
 *
 *   $ curl -sS -A 'CommissionWatch/1.0 (+https://commissionwatch.bmux.sh/about; …)' \
 *       -I -L 'https://archive-video.granicus.com/bozeman/bozeman_a1f0657c-….mp4'
 *   HTTP/2 403      server: CloudFront      x-cache: Error from cloudfront
 *
 *   $ curl -sS -A 'Mozilla/5.0 (X11; Linux x86_64) … Chrome/127.0.0.0 …' -I -L <same url>
 *   HTTP/2 200      content-length: 6008707697      server: AmazonS3
 *
 * The media itself is on a CDN that answers a browser string and refuses both our
 * honest user agent and curl's default. `bozeman.granicus.com/DownloadFile.php`,
 * the custodian's own download link, redirects straight onto it and inherits the
 * 403. **The only route to those bytes is to present a user agent we are not**,
 * which is browser-fingerprint spoofing and is the line this project does not
 * cross. So there is no audio to transcribe, and a transcription stage would have
 * been a pipeline with no input.
 *
 * What *is* fetchable, on the tenant host that has answered this project all along
 * and under the vendor-robots exception already disclosed on the Methodology page,
 * is the custodian's own player page: `MediaPlayer.php?view_id=1&clip_id=N`. It
 * states, in its own markup, the recording's media identifier and its length. That
 * is enough to say the thing the site currently cannot:
 *
 *   The City published a 2h 56m recording of the 2013-09-23 Commission meeting.
 *   There is no transcript of it, and we cannot lawfully obtain the recording.
 *
 * ## What a stranger can check
 *
 * `observed_sha256` is the hash of the exact player-page bytes every other column
 * was read out of. The page is byte-stable — the same clip fetched twice seven
 * minutes apart hashed identically — so the claim is reproducible with one
 * command, which is the same standard `transcript_status.observed_sha256` is held
 * to. It is deliberately **not** a foreign key to `artifacts`, for the reason
 * migration 072 gives: the row records which bytes were served on a date, and must
 * survive the artifact being deleted or never stored.
 *
 * `duration_ms` is corroborated rather than merely parsed: clip 2325's page states
 * 1678 seconds and the stored caption fixture for the same clip ends its last cue
 * at 1676 seconds.
 *
 * ## The two states
 *
 *   available   we read a media identifier and a length off the page — the record
 *   unreadable  we fetched the page and could not read it            — **us**
 *
 * There is no `absent`. A row exists only when the archive gave the meeting a clip
 * id, so "the custodian published no recording" is the absence of a row, and the
 * adapter already logs an archive row that carries no clip. Inventing a third
 * state for it would let our failure to parse and their failure to record share a
 * word.
 *
 * ## What this table may never grow
 *
 * No speaker column, no `member_id`, no person of any kind — the audio spec's Rule
 * 3, and it applies to a recording index exactly as it applies to a cue. Voice is
 * not something this project identifies, and a column here would be read as an
 * identity by every consumer that touched it however the comment above it read.
 * `test/recordings.test.ts` asserts the column list.
 */

export const MEETING_RECORDING_STATES = ['available', 'unreadable'] as const;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('meeting_recordings', (table) => {
    table
      .uuid('meeting_document_id')
      .primary()
      .references('id')
      .inTable('meeting_documents')
      .onDelete('CASCADE');

    table.text('state').notNullable();

    // Text, not integer, for the reason migration 089 gives: Granicus clip ids
    // are not chronological and not arithmetic, and storing them as a number
    // invites an ordering that means nothing.
    table.text('clip_id').notNullable();

    // The custodian's own name for the recording's bytes, e.g.
    // `bozeman_a1f0657c-7758-43c1-bb2c-a8450f107cb3`. It is the closest thing to
    // a content address we can hold for media we are not permitted to fetch: two
    // meetings naming the same media id are the same recording, and a media id
    // that changes is a recording the custodian replaced.
    table.text('media_id').nullable();

    // The stream URL exactly as the page publishes it. Recorded so a reader has
    // the custodian's address for the recording, never so that we fetch it — the
    // host it names refuses this project's user agent, and the honest response to
    // that is to publish the address and stop.
    table.text('media_url').nullable();

    table.integer('duration_ms').nullable();

    // How many agenda cue points the player page carries. The custodian publishes
    // a media-time index of its own; counting it here records that the index
    // exists without pretending we have joined it to `agenda_items`, which the
    // transcripts spec §6 explains cannot honestly be done yet.
    table.integer('index_point_count').nullable();

    table.string('observed_sha256', 64).notNullable();

    table.timestamp('first_checked_at', { useTz: true }).notNullable();
    table.timestamp('last_checked_at', { useTz: true }).notNullable();
    table.integer('checks').notNullable().defaultTo(1);

    // Non-null exactly when the state describes our failure. Held to the same
    // leak rule as `transcript_status.last_error`: it is operator-facing and no
    // public projection may select it.
    table.text('last_error').nullable();

    table.timestamps(true, true);
  });

  await knex.raw(`
    ALTER TABLE meeting_recordings
    ADD CONSTRAINT meeting_recordings_state_check
    CHECK (state IN (${MEETING_RECORDING_STATES.map((name) => `'${name}'`).join(', ')}))
  `);

  // Every disjunct below is wrapped in coalesce(..., false).
  //
  // A CHECK that evaluates to NULL is satisfied, and the row it admits is the one
  // that violates it hardest — the one with the columns simply absent. Four
  // constraints shipped with that defect in a single day (see
  // `test/migrations-selfcontained.test.ts`), two of them on the transcript
  // tables this one sits beside. `last_error IS NULL` cannot itself be NULL, but
  // it is wrapped anyway: the guard is uniform so that reading it requires no
  // case analysis, which is precisely what the four missed.
  await knex.raw(`
    ALTER TABLE meeting_recordings
    ADD CONSTRAINT meeting_recordings_available_check
    CHECK (
      state <> 'available'
      OR coalesce(
           duration_ms > 0
           AND media_id <> ''
           AND media_url <> ''
           AND index_point_count >= 0
           AND last_error IS NULL,
         false)
    )
  `);

  // An 'unreadable' with no error text is a failure nobody disclosed, and one
  // carrying a duration would be a failure that answered the question anyway.
  await knex.raw(`
    ALTER TABLE meeting_recordings
    ADD CONSTRAINT meeting_recordings_unreadable_check
    CHECK (
      state <> 'unreadable'
      OR coalesce(
           last_error IS NOT NULL
           AND duration_ms IS NULL
           AND media_id IS NULL,
         false)
    )
  `);

  // Every row states which bytes it was read out of. No exception for the failure
  // state: "we could not read this page" is a claim about a specific page.
  await knex.raw(`
    ALTER TABLE meeting_recordings
    ADD CONSTRAINT meeting_recordings_sha_check
    CHECK (observed_sha256 ~ '^[0-9a-f]{64}$')
  `);

  await knex.raw(`
    ALTER TABLE meeting_recordings
    ADD CONSTRAINT meeting_recordings_clip_id_check
    CHECK (clip_id <> '')
  `);

  await knex.raw(`
    ALTER TABLE meeting_recordings
    ADD CONSTRAINT meeting_recordings_checked_order_check
    CHECK (last_checked_at >= first_checked_at)
  `);

  await knex.raw(`
    ALTER TABLE meeting_recordings
    ADD CONSTRAINT meeting_recordings_checks_check
    CHECK (checks >= 1)
  `);

  await knex.raw('CREATE INDEX meeting_recordings_state ON meeting_recordings (state)');
  await knex.raw(
    'CREATE INDEX meeting_recordings_recheck ON meeting_recordings (last_checked_at)',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS meeting_recordings_recheck');
  await knex.raw('DROP INDEX IF EXISTS meeting_recordings_state');
  await knex.schema.dropTableIfExists('meeting_recordings');
}
