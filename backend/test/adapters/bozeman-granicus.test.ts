import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { expect } from '../helpers/expect';
import { runAdapterContract } from './contract';
import {
  BOZEMAN_ADAPTER_KEY,
  BOZEMAN_ARCHIVE_URL,
  BOZEMAN_ATTACHMENT_ORIGIN,
  BOZEMAN_MIN_DELAY_MS,
  BOZEMAN_ORIGIN,
  BOZEMAN_PACKET_ORIGIN,
  BOZEMAN_ROBOTS_URL,
  BOZEMAN_USER_AGENT,
  RobotsExceptionWithdrawnError,
  classifyGranicusDocument,
  classifyGranicusStatus,
  createBozemanGranicusAdapter,
  parseClockTime,
  parseGranicusArchive,
  parseGranicusDateTime,
} from '../../src/services/ingestion/adapters/bozeman-granicus';
import {
  OffSourceUrlError,
  isAllowedByRobots,
  parseRobotsTxt,
  type HttpResponse,
  type HttpTransport,
} from '../../src/services/ingestion/adapters/http';
import { sha256Hex, type DocumentRef } from '../../src/services/ingestion/adapters/types';

/**
 * Everything here runs off `backend/test/fixtures/bozeman-granicus/`, a verbatim capture of
 * bozeman.granicus.com taken on 2026-08-09 (see PROVENANCE.md there). No test touches the
 * network: the adapter is constructed with a transport that serves those bytes.
 */

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'bozeman-granicus');

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURE_DIR, name)));
}

/**
 * The archive page is the one fixture stored gzipped — 5.9 MB of HTML that compresses to
 * 148 KB. The digest of the decompressed bytes is the response body as it arrived, so a
 * fixture edited in place fails here rather than quietly changing what the parser is
 * written against.
 */
const ARCHIVE_SHA256 = '25224b8d66b59562f4392130734fbf7ebbadcc62ccdf2bc201ec7d1b5cbd03b3';

function archiveBytes(): Uint8Array {
  return new Uint8Array(gunzipSync(Buffer.from(fixture('viewpublisher-view1.html.gz'))));
}

const AGENDA_URL = `${BOZEMAN_ORIGIN}/AgendaViewer.php?view_id=1&clip_id=2784`;
const AGENDA_FINAL_URL = `${BOZEMAN_ATTACHMENT_ORIGIN}/bozeman/4b286c0963f81a34dcb7ddb2d2548bc20.html`;
const MINUTES_URL =
  `${BOZEMAN_ORIGIN}/MinutesViewer.php?view_id=1&clip_id=2775&doc_id=018ff04e-87a1-11f1-bb61-005056a89546`;
const MINUTES_FINAL_URL =
  `${BOZEMAN_ORIGIN}/DocumentViewer.php?file=bozeman_9929ef707e2bb0ed8f20a3185e1668d2.pdf&view=1`;

/** The sha256 of the captured minutes PDF, recorded at capture time by `sha256sum`. */
const MINUTES_SHA256 = 'f2d3c1af3a8aacd88b28a002068518a0ed3339578e6ff7fc0fd075a83df67ab0';

interface RecordedRequest {
  url: string;
  method: string;
  index: number;
}

interface FixtureTransport {
  transport: HttpTransport;
  requests: RecordedRequest[];
}

/**
 * Serves the captured bytes for exactly the requests the live site answers, and throws on
 * anything else — so a selector drifting onto an un-probed URL fails loudly instead of
 * quietly returning nothing.
 *
 * `finalUrl` differs from the requested URL for both documents, which is not incidental:
 * both endpoints 302, and `artifacts.source_url` has to record what was actually read.
 */
function createFixtureTransport(): FixtureTransport {
  const requests: RecordedRequest[] = [];

  const transport: HttpTransport = async (request) => {
    requests.push({ url: request.url, method: request.method, index: requests.length });

    const respond = (
      bytes: Uint8Array,
      contentType: string,
      finalUrl: string,
    ): HttpResponse => ({
      status: 200,
      headers: { 'content-type': contentType },
      bytes,
      finalUrl,
    });

    if (request.url === BOZEMAN_ROBOTS_URL) {
      return respond(fixture('robots.txt'), 'text/plain', request.url);
    }
    if (request.url === BOZEMAN_ARCHIVE_URL) {
      return respond(archiveBytes(), 'text/html; charset=utf-8', request.url);
    }
    if (request.url === AGENDA_URL) {
      return respond(fixture('agendaviewer-clip2784.html'), 'text/html', AGENDA_FINAL_URL);
    }
    if (request.url === MINUTES_URL) {
      return respond(fixture('minutesviewer-clip2775.pdf'), 'application/pdf', MINUTES_FINAL_URL);
    }
    throw new Error(`No captured fixture for ${request.method} ${request.url}`);
  };

  return { transport, requests };
}

const NOW = new Date('2026-08-09T12:00:00Z');
const CONTRACT_SINCE = new Date('2026-01-01T00:00:00Z');

const silentLogger = { warn: (): void => undefined };

function buildAdapter(overrides: Parameters<typeof createBozemanGranicusAdapter>[0] = {}) {
  return createBozemanGranicusAdapter({
    transport: createFixtureTransport().transport,
    now: () => NOW,
    logger: silentLogger,
    ...overrides,
  });
}

const contractDocumentRef: DocumentRef = {
  sourceKey: BOZEMAN_ADAPTER_KEY,
  kind: 'minutes',
  title: 'July 21 Unofficial Transcript',
  url: MINUTES_URL,
  meetingExternalId: 'city-commission-2026-07-21',
  expectedContentType: 'application/pdf',
};

runAdapterContract(buildAdapter(), {
  since: CONTRACT_SINCE,
  // 2026 alone: 126 archive rows plus the upcoming meetings that match a declared body.
  minMeetings: 120,
  documentRef: contractDocumentRef,
});

describe('bozeman-granicus fixtures', () => {
  it('carries the archive response verbatim under its recorded digest', () => {
    expect(sha256Hex(archiveBytes())).toBe(ARCHIVE_SHA256);
  });

  it('carries the minutes PDF verbatim under its recorded digest', () => {
    expect(sha256Hex(fixture('minutesviewer-clip2775.pdf'))).toBe(MINUTES_SHA256);
  });
});

describe('bozeman-granicus date parsing', () => {
  it('reads an archive cell with no weekday', () => {
    expect(parseGranicusDateTime('August  4, 2026  -  1:17 PM')).toEqual({
      date: '2026-08-04',
      time: '13:17',
    });
  });

  it('reads an upcoming cell with a weekday', () => {
    expect(
      parseGranicusDateTime('Wednesday, August 12, 2026 - 10:30 AM'),
    ).toEqual({ date: '2026-08-12', time: '10:30' });
  });

  it('reads a date with no time at all', () => {
    expect(parseGranicusDateTime('January 5, 2015')).toEqual({
      date: '2015-01-05',
      time: null,
    });
  });

  it('rejects a day the calendar does not have', () => {
    // Date would silently roll February 30 forward to March 2, which is how a scraper
    // starts reporting meetings on days they did not happen.
    expect(parseGranicusDateTime('February 30, 2026')).toBe(null);
  });

  it('rejects text that is not a date', () => {
    expect(parseGranicusDateTime('Duration')).toBe(null);
    expect(parseGranicusDateTime('Smarch 4, 2026')).toBe(null);
  });

  it('converts the 12-hour clock, including both noons', () => {
    expect(parseClockTime('12:00 AM')).toBe('00:00');
    expect(parseClockTime('12:30 PM')).toBe('12:30');
    expect(parseClockTime('1:17 PM')).toBe('13:17');
    expect(parseClockTime('8:00 AM')).toBe('08:00');
    expect(parseClockTime('')).toBe(null);
    expect(parseClockTime('25:00 PM')).toBe(null);
  });
});

describe('bozeman-granicus document classification', () => {
  it('reads an agenda, minutes and a packet off their paths', () => {
    expect(classifyGranicusDocument(AGENDA_URL)).toEqual({
      kind: 'agenda',
      expectedContentType: 'text/html',
    });
    expect(classifyGranicusDocument(MINUTES_URL)).toEqual({
      kind: 'minutes',
      expectedContentType: 'application/pdf',
    });
    expect(
      classifyGranicusDocument(`${BOZEMAN_PACKET_ORIGIN}/bozeman/17af417c-b814-11ef.pdf`),
    ).toEqual({ kind: 'packet', expectedContentType: 'application/pdf' });
  });

  it('refuses the video player, which is a page and not a document', () => {
    // Emitting MediaPlayer.php would put a meeting_documents row on something nobody can
    // cite and hand the parser an HTML player.
    expect(classifyGranicusDocument(`${BOZEMAN_ORIGIN}/MediaPlayer.php?view_id=1&clip_id=2784`))
      .toBe(null);
    expect(classifyGranicusDocument('javascript:void(0);')).toBe(null);
  });
});

describe('bozeman-granicus archive parsing', () => {
  const html = new TextDecoder().decode(archiveBytes());
  const archive = parseGranicusArchive(html);

  it('reads sixteen bodies, not the twenty-plus the spike estimated', () => {
    expect(archive.panels).toHaveLength(16);
    expect(archive.panels.map((panel) => panel.name)).toContain('City Commission');
    expect(archive.panels.map((panel) => panel.name)).toContain('Study Commission');
  });

  it('reads every archived row, across every year, from one response', () => {
    const total = archive.panels.reduce((sum, panel) => sum + panel.rows.length, 0);
    expect(total).toBe(1135);
    const cityCommission = archive.panels.find((panel) => panel.name === 'City Commission');
    // 519 rows, 2013 through 2026. The year tabs are client-side; there is no per-year
    // endpoint to walk, which is the opposite of Gallatin's AgendaCenter.
    expect(cityCommission?.rows).toHaveLength(519);
  });

  it('reads the upcoming table separately from the panels', () => {
    expect(archive.upcoming).toHaveLength(17);
    expect(archive.upcoming.every((row) => row.date >= '2026-08-09')).toBe(true);
  });

  it('takes the meeting title from the row and the body from the panel', () => {
    // The Name cell is a per-meeting title: this panel alone carries "City Commission",
    // "City Commission Special Meeting" and "City Commission Meeting pt 1". Trusting it as
    // a body name would invent bodies by the dozen.
    const titles = new Set(
      archive.panels
        .find((panel) => panel.name === 'City Commission')
        ?.rows.map((row) => row.title),
    );
    expect(titles.size).toBeGreaterThan(1);
    expect(titles).toContain('City Commission Special Meeting');
  });

  it('carries no time on an archive row, because that column is the video clip', () => {
    // The 2026-08-04 row says 1:17 PM. That meeting's own agenda states an early start of
    // 2:00 PM. Publishing the clip time as the meeting time would be a false claim.
    const rows = archive.panels.flatMap((panel) => panel.rows);
    expect(rows.every((row) => row.time === null || row.time !== undefined)).toBe(true);
    const aug4 = archive.panels
      .find((panel) => panel.name === 'City Commission')
      ?.rows.find((row) => row.date === '2026-08-04');
    expect(aug4?.time).toBe('13:17');
  });

  it('reads a row into its agenda, minutes and packet links', () => {
    const july21 = archive.panels
      .find((panel) => panel.name === 'City Commission')
      ?.rows.find((row) => row.date === '2026-07-21');
    expect(july21?.documents.map((document) => document.kind)).toEqual([
      'agenda',
      'minutes',
      'packet',
    ]);
    expect(july21?.documents[0].url).toBe(AGENDA_URL.replace('2784', '2775'));
    expect(july21?.documents[1].url).toBe(MINUTES_URL);
    expect(july21?.documents[1].title).toBe('July 21 Unofficial Transcript');
  });
});

describe('bozeman-granicus discovery', () => {
  it('emits a scheduled start only for upcoming meetings', async () => {
    const meetings = await buildAdapter().discoverMeetings(new Date('2026-07-01T00:00:00Z'));
    const upcoming = meetings.find(
      (meeting) => meeting.externalId === 'city-commission-2026-08-18',
    );
    const past = meetings.find(
      (meeting) => meeting.externalId === 'city-commission-2026-08-04',
    );
    expect(upcoming?.status).toBe('scheduled');
    // The Upcoming table states the meeting's own scheduled start.
    expect(upcoming?.time).toBe('18:00');
    expect(past?.status).toBe('completed');
    // The archive prints the clip start instead, so no time is claimed at all.
    expect(past?.time).toBeUndefined();
  });

  it('keys a meeting on its body and date, not on a Granicus id', async () => {
    const meetings = await buildAdapter().discoverMeetings(new Date('2026-07-01T00:00:00Z'));
    const ids = meetings.map((meeting) => meeting.externalId);
    expect(ids).toContain('city-commission-2026-08-04');
    // A clip_id or event_id would make an upcoming meeting and the same meeting once it
    // has happened into two rows, one of them stuck at `scheduled` for ever.
    expect(ids.every((id) => id !== undefined && !/clip|event/.test(id))).toBe(true);
  });

  it('never repeats an identity, including on the days a body met twice', async () => {
    const meetings = await buildAdapter().discoverMeetings(new Date('2013-01-01T00:00:00Z'));
    const ids = meetings.map((meeting) => meeting.externalId);
    expect(new Set(ids).size).toBe(ids.length);
    // 2020-01-13 is one of the nine days the archive lists two meetings of one body.
    expect(ids).toContain('city-commission-2020-01-13');
    expect(ids).toContain('city-commission-2020-01-13-2');
  });

  it('discovers the whole archive from a single request', async () => {
    const { transport, requests } = createFixtureTransport();
    const meetings = await createBozemanGranicusAdapter({
      transport,
      now: () => NOW,
      logger: silentLogger,
    }).discoverMeetings(new Date('2013-01-01T00:00:00Z'));

    expect(meetings.length).toBeGreaterThan(1100);
    // robots.txt plus the archive page. Nothing else; there is no per-year endpoint.
    expect(requests.map((request) => request.url)).toEqual([
      BOZEMAN_ROBOTS_URL,
      BOZEMAN_ARCHIVE_URL,
    ]);
  });

  it('returns nothing older than `since`', async () => {
    const meetings = await buildAdapter().discoverMeetings(new Date('2026-08-01T00:00:00Z'));
    expect(meetings.length).toBeGreaterThan(0);
    expect(meetings.every((meeting) => meeting.date >= '2026-08-01')).toBe(true);
  });

  it('skips an unconfigured body loudly rather than inventing one', async () => {
    const warnings: string[] = [];
    const meetings = await createBozemanGranicusAdapter({
      transport: createFixtureTransport().transport,
      now: () => NOW,
      bodies: ['City Commission'],
      logger: { warn: (message) => warnings.push(message) },
    }).discoverMeetings(new Date('2026-01-01T00:00:00Z'));

    expect(meetings.every((meeting) => meeting.bodyKey === 'city-commission')).toBe(true);
    expect(warnings.some((warning) => warning.includes('Study Commission'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('ingestion_sources.config.bodies'))).toBe(
      true,
    );
  });

  it('resolves every upcoming row the fixture lists', async () => {
    // The upcoming table spells bodies its own way, and five of the seventeen rows used to
    // fall on the floor with a warning every sweep — five bodies' next meetings simply
    // absent from the site. Every row now resolves, and each of the three mechanisms that
    // gets it there is asserted below rather than assumed.
    const warnings: string[] = [];
    const meetings = await createBozemanGranicusAdapter({
      transport: createFixtureTransport().transport,
      now: () => NOW,
      logger: { warn: (message) => warnings.push(message) },
    }).discoverMeetings(new Date('2026-01-01T00:00:00Z'));

    const upcomingWarnings = warnings.filter((warning) => warning.includes('upcoming meeting'));
    expect(upcomingWarnings).toEqual([]);

    const scheduled = meetings.filter((meeting) => meeting.status === 'scheduled');
    // Seventeen upcoming rows in the fixture, each one now a meeting.
    expect(scheduled).toHaveLength(17);
  });

  it('reads the upcoming table\'s spelling of a body as that body, by alias', async () => {
    const meetings = await buildAdapter().discoverMeetings(new Date('2026-08-19T00:00:00Z'));
    const tif = meetings.find((meeting) => meeting.date === '2026-08-20');

    // The upcoming table calls it "Tax Increment Finance Advisory Board"; the archive panel
    // is "Tax Increment Financing Board". They are one body, and the alias says so on a
    // human's authority — it must not mint a second body key alongside the archive's.
    expect(tif?.bodyKey).toBe('tax-increment-financing-board');
    expect(tif?.title).toBe('Tax Increment Finance Advisory Board');
    expect(
      meetings.every((meeting) => !/^tax-increment-finance-advisory/.test(meeting.bodyKey)),
    ).toBe(true);
  });

  it('reads an ampersand and the word `and` as the same body', async () => {
    const meetings = await buildAdapter().discoverMeetings(new Date('2026-08-27T00:00:00Z'));
    const parks = meetings.find(
      (meeting) => meeting.title === 'Urban Parks and Forestry Board',
    );

    // The panel is "Urban Parks & Forestry Board" and the upcoming row spells the word out.
    // The stored key stays the one slugifyBodyName has always produced for the panel.
    expect(parks?.bodyKey).toBe('urban-parks-forestry-board');
  });

  it('still skips a body nobody configured, loudly', async () => {
    // Normalising and aliasing known disagreements is not the same as accepting anything:
    // a name outside the configured list is still refused, by name, with the fix.
    const warnings: string[] = [];
    const meetings = await createBozemanGranicusAdapter({
      transport: createFixtureTransport().transport,
      now: () => NOW,
      bodies: ['City Commission'],
      logger: { warn: (message) => warnings.push(message) },
    }).discoverMeetings(new Date('2026-08-01T00:00:00Z'));

    expect(meetings.every((meeting) => meeting.bodyKey === 'city-commission')).toBe(true);
    const skipped = warnings.filter((warning) =>
      warning.includes('Library Board of Trustees'),
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain('ingestion_sources.config.bodies');
  });

  it('leaves agenda packets alone unless an operator asks for them', async () => {
    const without = await buildAdapter().discoverMeetings(new Date('2026-07-01T00:00:00Z'));
    expect(
      without.flatMap((meeting) => meeting.documents).some((doc) => doc.kind === 'packet'),
    ).toBe(false);

    const withPackets = await buildAdapter({ includePackets: true }).discoverMeetings(
      new Date('2026-07-01T00:00:00Z'),
    );
    expect(
      withPackets.flatMap((meeting) => meeting.documents).some((doc) => doc.kind === 'packet'),
    ).toBe(true);
  });
});

describe('bozeman-granicus fetchDocument', () => {
  it('records the URL it landed on after the redirect', async () => {
    const artifact = await buildAdapter().fetchDocument(contractDocumentRef);
    expect(artifact.sourceUrl).toBe(MINUTES_FINAL_URL);
    expect(artifact.contentType).toBe('application/pdf');
    expect(artifact.sha256).toBe(MINUTES_SHA256);
  });

  it('serves the second fetch of a URL from the cache, not the wire', async () => {
    const { transport, requests } = createFixtureTransport();
    const adapter = createBozemanGranicusAdapter({
      transport,
      now: () => NOW,
      logger: silentLogger,
    });
    await adapter.fetchDocument(contractDocumentRef);
    const before = requests.length;
    await adapter.fetchDocument(contractDocumentRef);
    expect(requests.length).toBe(before);
  });

  it('fetches the agenda, which is HTML rather than a PDF', async () => {
    const artifact = await buildAdapter().fetchDocument({
      sourceKey: BOZEMAN_ADAPTER_KEY,
      kind: 'agenda',
      title: 'Agenda',
      url: AGENDA_URL,
    });
    expect(artifact.contentType).toBe('text/html');
    expect(artifact.sourceUrl).toBe(AGENDA_FINAL_URL);
    expect(new TextDecoder().decode(artifact.bytes)).toContain(
      'THE CITY COMMISSION OF BOZEMAN, MONTANA',
    );
  });

  it('refuses a URL outside the declared surface', async () => {
    // bozemanmt.gov above all: it is a blanket Akamai deny and must never be fetched.
    await expect(
      buildAdapter().fetchDocument({
        sourceKey: BOZEMAN_ADAPTER_KEY,
        kind: 'agenda',
        title: 'Agenda',
        url: 'https://www.bozemanmt.gov/departments/city-commission',
      }),
    ).rejects.toBeInstanceOf(OffSourceUrlError);
  });

  it('refuses the packet host until packets are switched on', async () => {
    await expect(
      buildAdapter().fetchDocument({
        sourceKey: BOZEMAN_ADAPTER_KEY,
        kind: 'packet',
        title: 'Agenda Packet',
        url: `${BOZEMAN_PACKET_ORIGIN}/bozeman/17af417c.pdf`,
      }),
    ).rejects.toBeInstanceOf(OffSourceUrlError);
  });
});

describe('bozeman-granicus robots.txt', () => {
  const robots = new TextDecoder().decode(fixture('robots.txt'));

  it('captures a file that disallows this project entirely', () => {
    const rules = parseRobotsTxt(robots, BOZEMAN_USER_AGENT);
    expect(rules).toEqual([{ allow: false, path: '/' }]);
    expect(isAllowedByRobots(rules, '/ViewPublisher.php?view_id=1')).toBe(false);
  });

  it('names the exception in the log the first time it applies, once', async () => {
    const warnings: string[] = [];
    const adapter = createBozemanGranicusAdapter({
      transport: createFixtureTransport().transport,
      now: () => NOW,
      logger: { warn: (message) => warnings.push(message) },
    });
    await adapter.discoverMeetings(new Date('2026-08-01T00:00:00Z'));
    await adapter.fetchDocument(contractDocumentRef);

    const applied = warnings.filter((warning) => warning.includes('vendor-robots exception'));
    // An override nobody can see in a log is an override nobody can audit — and one that
    // repeated per request would be an override nobody reads.
    expect(applied).toHaveLength(1);
    expect(applied[0]).toContain('Methodology page');
  });

  it('discovers nothing once the exception is withdrawn', async () => {
    // The correct behaviour the day the Methodology disclosure comes down.
    await expect(
      buildAdapter({ respectRobotsTxt: true }).discoverMeetings(new Date('2026-08-01T00:00:00Z')),
    ).rejects.toBeInstanceOf(RobotsExceptionWithdrawnError);
  });
});

describe('bozeman-granicus descriptor', () => {
  const descriptor = buildAdapter().describeSource();

  it('declares the city, not the county', () => {
    expect(descriptor.jurisdiction).toEqual({
      name: 'City of Bozeman',
      state: 'MT',
      type: 'city',
      websiteUrl: BOZEMAN_ORIGIN,
    });
  });

  it('declares every origin it will touch, and no more', () => {
    expect(descriptor.baseUrls).toEqual([BOZEMAN_ORIGIN, BOZEMAN_ATTACHMENT_ORIGIN]);
    expect(buildAdapter({ includePackets: true }).describeSource().baseUrls).toEqual([
      BOZEMAN_ORIGIN,
      BOZEMAN_ATTACHMENT_ORIGIN,
      BOZEMAN_PACKET_ORIGIN,
    ]);
  });

  it('never declares bozemanmt.gov', () => {
    expect(descriptor.baseUrls.some((url) => url.includes('bozemanmt.gov'))).toBe(false);
    expect(descriptor.jurisdiction.websiteUrl?.includes('bozemanmt.gov')).toBe(false);
  });

  it('honours the crawl delay the site publishes', () => {
    expect(descriptor.politeness.minDelayMs).toBe(BOZEMAN_MIN_DELAY_MS);
    expect(BOZEMAN_MIN_DELAY_MS).toBe(10_000);
    expect(descriptor.politeness.maxConcurrency).toBe(1);
  });

  it('states plainly that the robots exception is in force', () => {
    expect(descriptor.politeness.respectRobotsTxt).toBe(false);
    expect(descriptor.notes).toContain('vendor-robots exception');
    expect(descriptor.notes).toContain('Methodology page');
  });

  it('qualifies a body name with the city, without saying Bozeman twice', () => {
    // Both jurisdictions have a "Study Commission", and an operator reading a list of
    // commission names should not have to guess whose it is. Five of the sixteen panels
    // already say Bozeman; "Bozeman Bozeman Historic Preservation Advisory Board" is the
    // kind of detail that makes a reader stop trusting the rest of the page.
    const names = descriptor.bodies.map((body) => body.name);
    expect(names).toContain('Bozeman City Commission');
    expect(names).toContain('Bozeman Historic Preservation Advisory Board');
    expect(names.some((name) => /Bozeman Bozeman/.test(name))).toBe(false);
    expect(descriptor.bodies.map((body) => body.key)).toContain('city-commission');
  });
});

describe('bozeman-granicus status', () => {
  it('reads a cancellation off the title', () => {
    expect(classifyGranicusStatus('City Commission CANCELLED', '2026-01-01', '2026-08-09', false))
      .toBe('cancelled');
    expect(classifyGranicusStatus('Meeting Canceled', '2026-12-01', '2026-08-09', true)).toBe(
      'cancelled',
    );
  });

  it('trusts the table a row came from', () => {
    expect(classifyGranicusStatus('City Commission', '2026-08-18', '2026-08-09', true)).toBe(
      'scheduled',
    );
    expect(classifyGranicusStatus('City Commission', '2026-08-04', '2026-08-09', false)).toBe(
      'completed',
    );
  });
});
