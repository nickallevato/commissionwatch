import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { expect } from '../helpers/expect';
import { runAdapterContract } from './contract';
import { parseRetryAfter } from '../../src/services/ingestion/adapters/http';
import {
  GALLATIN_ADAPTER_KEY,
  GALLATIN_AGENDA_CENTER_URL,
  GALLATIN_MIN_DELAY_MS,
  GALLATIN_ORIGIN,
  GALLATIN_ROBOTS_URL,
  GALLATIN_UPDATE_CATEGORY_URL,
  HttpStatusError,
  OffSourceUrlError,
  RobotsDisallowedError,
  classifyDocumentKind,
  classifyMeetingStatus,
  createGallatinCivicPlusAdapter,
  createMemoryDocumentCache,
  createPoliteTransport,
  isAllowedByRobots,
  isViewFileUrl,
  localCalendarDate,
  parseAgendaCenterIndex,
  parseCategorySection,
  parseDateFromExternalId,
  parseLongDate,
  parseRobotsTxt,
  slugifyBodyName,
  type CachedDocument,
  type DocumentCache,
  type FetchLike,
  type FetchLikeInit,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from '../../src/services/ingestion/adapters/gallatin-civicplus';
import type { DocumentRef } from '../../src/services/ingestion/adapters/types';

/**
 * Everything here runs off `backend/test/fixtures/gallatin/`, which is a verbatim capture of
 * gallatinmt.gov taken on 2026-08-04 (see PROVENANCE.md there). No test touches the
 * network: the adapter is constructed with a transport that serves those bytes.
 */

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'gallatin');

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURE_DIR, name)));
}

const PDF_URL = `${GALLATIN_ORIGIN}/AgendaCenter/ViewFile/Agenda/_06022025-2`;

/** The sha256 of the captured PDF, recorded at capture time by `sha256sum`. */
const PDF_SHA256 = '3b53b21b970f6cfd791ed0b537aedc551cbe248ee9c646d793a1bfc40ee1f00e';

interface RecordedRequest extends HttpRequest {
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
 */
function createFixtureTransport(): FixtureTransport {
  const requests: RecordedRequest[] = [];

  const transport: HttpTransport = async (request) => {
    requests.push({ ...request, index: requests.length });

    const html = (bytes: Uint8Array): HttpResponse => ({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      bytes,
      finalUrl: request.url,
    });

    if (request.url === GALLATIN_ROBOTS_URL) {
      return {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        bytes: fixture('robots.txt'),
        finalUrl: request.url,
      };
    }

    if (request.url === GALLATIN_AGENDA_CENTER_URL && request.method === 'GET') {
      return html(fixture('agendacenter-index.html'));
    }

    if (request.url === GALLATIN_UPDATE_CATEGORY_URL && request.method === 'POST') {
      const form = new URLSearchParams(request.body ?? '');
      const key = `${form.get('catID')}-${form.get('year')}`;
      if (key === '4-2025') return html(fixture('updatecategorylist-cat4-2025.html'));
      if (key === '14-2026') return html(fixture('updatecategorylist-cat14-2026-empty.html'));
      throw new Error(`No captured UpdateCategoryList fixture for catID/year ${key}`);
    }

    if (request.url === PDF_URL) {
      return {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
        bytes: fixture('viewfile-agenda-06022025-2.pdf'),
        finalUrl: request.url,
      };
    }

    throw new Error(`No captured fixture for ${request.method} ${request.url}`);
  };

  return { transport, requests };
}

const CONTRACT_SINCE = new Date('2025-01-01T00:00:00Z');

const contractDocumentRef: DocumentRef = {
  sourceKey: GALLATIN_ADAPTER_KEY,
  kind: 'agenda',
  title: 'BSTRP Regular Meeting Agenda',
  url: PDF_URL,
  meetingExternalId: '06022025-2',
  expectedContentType: 'application/pdf',
};

runAdapterContract(
  createGallatinCivicPlusAdapter({
    transport: createFixtureTransport().transport,
    now: () => new Date('2026-08-04T12:00:00Z'),
  }),
  {
    since: CONTRACT_SINCE,
    // The index alone yields 8; walking Weed Board 2025 adds 10.
    minMeetings: 18,
    documentRef: contractDocumentRef,
  },
);

describe('gallatin-civicplus parsing', () => {
  const indexHtml = new TextDecoder().decode(fixture('agendacenter-index.html'));
  const cat4Html = new TextDecoder().decode(fixture('updatecategorylist-cat4-2025.html'));
  const emptyHtml = new TextDecoder().decode(fixture('updatecategorylist-cat14-2026-empty.html'));

  it('reads every category heading off the index', () => {
    const { categories } = parseAgendaCenterIndex(indexHtml);
    expect(categories.map((category) => category.catId)).toEqual([3, 2, 4]);
    expect(categories.map((category) => category.name)).toEqual([
      'Big Sky Meadow Trails, Recreation & Parks Special District',
      'Study Commission',
      'Weed Board',
    ]);
  });

  it('reads the rendered year and every offered year per category', () => {
    const { sections } = parseAgendaCenterIndex(indexHtml);
    const byCatId = new Map(sections.map((section) => [section.catId, section]));

    // Categories do not share a rendered year: Big Sky's newest content is 2025.
    expect(byCatId.get(3)?.currentYear).toBe(2025);
    expect(byCatId.get(3)?.years).toEqual([2025, 2022]);
    expect(byCatId.get(2)?.currentYear).toBe(2026);
    expect(byCatId.get(4)?.currentYear).toBe(2026);
    // Includes the years hidden behind the "View More" drop-down.
    expect(byCatId.get(4)?.years).toEqual([
      2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018,
    ]);
  });

  it('parses a row into a date, a title and its agenda link', () => {
    const { sections } = parseAgendaCenterIndex(indexHtml);
    const bigSky = sections.find((section) => section.catId === 3);
    expect(bigSky?.rows).toHaveLength(1);
    expect(bigSky?.rows[0]).toEqual({
      externalId: '06022025-2',
      date: '2025-06-02',
      title: 'BSTRP Regular Meeting Agenda',
      documents: [
        {
          kind: 'agenda',
          title: 'BSTRP Regular Meeting Agenda',
          url: `${GALLATIN_ORIGIN}/AgendaCenter/ViewFile/Agenda/_06022025-2`,
          expectedContentType: 'application/pdf',
        },
      ],
    });
  });

  it('claims application/pdf only where the source says pdf', () => {
    // The Aug 6 2026 Weed Board agenda is classed `html` in the drop-down and the live
    // URL serves a Word document. A blanket application/pdf guess would be a false claim
    // about the record and would hand the PDF parser a .docx.
    const rows = parseAgendaCenterIndex(indexHtml).sections.flatMap((section) => section.rows);
    const docx = rows.find((row) => row.externalId === '08062026-108');
    expect(docx?.documents[0].expectedContentType).toBeUndefined();

    const pdf = rows.find((row) => row.externalId === '06022025-2');
    expect(pdf?.documents[0].expectedContentType).toBe('application/pdf');
  });

  it('picks up the minutes link from its own cell', () => {
    const section = parseCategorySection(cat4Html, 4);
    expect(section?.rows).toHaveLength(10);
    const december = section?.rows.find((row) => row.date === '2025-12-04');
    expect(december?.documents.map((document) => document.kind)).toEqual([
      'agenda',
      'minutes',
    ]);
    expect(december?.documents[1].url).toBe(
      `${GALLATIN_ORIGIN}/AgendaCenter/ViewFile/Minutes/_12042025-101`,
    );
  });

  it('drops the Previous Versions link, which is a revision page and not a document', () => {
    const { sections } = parseAgendaCenterIndex(indexHtml);
    const amended = sections
      .flatMap((section) => section.rows)
      .find((row) => row.externalId === '04022026-104');
    // The row's heading also carries "— Amended Jun 24, 2026 8:48 AM"; the meeting date
    // still comes from the aria-label and is unaffected by it.
    expect(amended?.date).toBe('2026-04-02');
    expect(amended?.documents.map((document) => document.url)).toEqual([
      `${GALLATIN_ORIGIN}/AgendaCenter/ViewFile/Agenda/_04022026-104`,
      `${GALLATIN_ORIGIN}/AgendaCenter/ViewFile/Minutes/_04022026-104`,
    ]);
  });

  it('never emits a document that is not a ViewFile URL', () => {
    const rows = [
      ...parseAgendaCenterIndex(indexHtml).sections.flatMap((section) => section.rows),
      ...(parseCategorySection(cat4Html, 4)?.rows ?? []),
    ];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      for (const document of row.documents) {
        expect(isViewFileUrl(document.url)).toBe(true);
      }
    }
  });

  it('reads no rows from the whole-page response an empty category returns', () => {
    // catID=14 is answered with a whole AgendaCenter page, not the span#section14
    // fragment the other categories return. Scoping to that span is what makes the
    // response read as "no meetings" instead of as a parse of a page of site chrome.
    expect(emptyHtml.trimStart().startsWith('<!DOCTYPE html>')).toBe(true);
    expect(emptyHtml).not.toContain('id="section14"');
    expect(parseCategorySection(emptyHtml, 14)).toBeNull();
  });

  it('does not attribute one category\'s rows to another', () => {
    // The same guard, stated as the property it protects: asking the index for a
    // category it does not render must not hand back the categories it does.
    expect(indexHtml).toContain('catAgendaRow');
    expect(parseCategorySection(indexHtml, 14)).toBeNull();
    expect(parseCategorySection(indexHtml, 3)?.rows).toHaveLength(1);
  });
});

describe('gallatin-civicplus date handling', () => {
  it('parses the long dates the aria-labels carry', () => {
    expect(parseLongDate('December 4, 2025')).toBe('2025-12-04');
    expect(parseLongDate('June 2, 2025')).toBe('2025-06-02');
    expect(parseLongDate('September 07, 2025')).toBe('2025-09-07');
  });

  it('refuses dates that do not exist rather than rolling them forward', () => {
    expect(parseLongDate('February 30, 2025')).toBeNull();
    expect(parseLongDate('Smarch 4, 2025')).toBeNull();
    expect(parseLongDate('4 December 2025')).toBeNull();
    expect(parseDateFromExternalId('02302025-9')).toBeNull();
  });

  it('falls back to the MMDDYYYY prefix the source id carries', () => {
    expect(parseDateFromExternalId('12042025-101')).toBe('2025-12-04');
    expect(parseDateFromExternalId('_06022025-2')).toBe('2025-06-02');
    expect(parseDateFromExternalId('not-an-id')).toBeNull();
  });

  it('reads today as a wall clock in Montana, not in UTC', () => {
    // 01:30 UTC on the 5th is still the 4th in Mountain Time.
    expect(localCalendarDate(new Date('2026-08-05T01:30:00Z'), 'America/Denver')).toBe(
      '2026-08-04',
    );
  });

  it('derives status from the date and reports a cancelled row as cancelled', () => {
    expect(classifyMeetingStatus('Regular Meeting Agenda', '2026-09-01', '2026-08-04')).toBe(
      'scheduled',
    );
    expect(classifyMeetingStatus('Regular Meeting Agenda', '2026-08-04', '2026-08-04')).toBe(
      'completed',
    );
    expect(classifyMeetingStatus('Regular Meeting Agenda', '2025-06-02', '2026-08-04')).toBe(
      'completed',
    );
    expect(classifyMeetingStatus('CANCELLED - Weed Board', '2026-09-01', '2026-08-04')).toBe(
      'cancelled',
    );
    expect(classifyMeetingStatus('Meeting Canceled', '2026-09-01', '2026-08-04')).toBe(
      'cancelled',
    );
  });
});

describe('gallatin-civicplus classification', () => {
  it('classifies by URL segment ahead of label', () => {
    expect(
      classifyDocumentKind(`${GALLATIN_ORIGIN}/AgendaCenter/ViewFile/Minutes/_1`, 'Agenda'),
    ).toBe('minutes');
    expect(
      classifyDocumentKind(`${GALLATIN_ORIGIN}/AgendaCenter/ViewFile/Agenda/_1`, 'Agenda'),
    ).toBe('agenda');
    expect(
      classifyDocumentKind(
        `${GALLATIN_ORIGIN}/AgendaCenter/ViewFile/Agenda/_1`,
        'Agenda Packet',
      ),
    ).toBe('packet');
  });

  it('slugifies category names into body keys the contract accepts', () => {
    expect(slugifyBodyName('Weed Board')).toBe('weed-board');
    expect(slugifyBodyName('Planning & Zoning Commission')).toBe('planning-zoning-commission');
    expect(slugifyBodyName('Big Sky Meadow Trails, Recreation & Parks Special District')).toBe(
      'big-sky-meadow-trails-recreation-parks-special-district',
    );
    expect(slugifyBodyName('Weed Board')).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});

describe('gallatin-civicplus robots.txt', () => {
  const robots = new TextDecoder().decode(fixture('robots.txt'));
  const rules = parseRobotsTxt(
    robots,
    'CommissionWatch/0.1 (civic transparency project; +https://commissionwatch.bmux.sh)',
  );

  it('takes the wildcard group, not Baiduspider or Yandex blanket bans', () => {
    // Both of those groups are `Disallow: /`. Picking one would block the whole site.
    expect(isAllowedByRobots(rules, '/')).toBe(true);
    expect(rules.some((rule) => rule.path === '/')).toBe(false);
  });

  it('permits the AgendaCenter paths the adapter uses', () => {
    expect(isAllowedByRobots(rules, '/AgendaCenter')).toBe(true);
    expect(isAllowedByRobots(rules, '/AgendaCenter/UpdateCategoryList')).toBe(true);
    expect(isAllowedByRobots(rules, '/AgendaCenter/ViewFile/Agenda/_06022025-2')).toBe(true);
  });

  it('honours the disallowed prefixes', () => {
    expect(isAllowedByRobots(rules, '/admin')).toBe(false);
    expect(isAllowedByRobots(rules, '/common/admin/thing')).toBe(false);
    expect(isAllowedByRobots(rules, '/Search')).toBe(false);
    expect(isAllowedByRobots(rules, '/search.aspx')).toBe(false);
  });

  it('does not read "Disallow: /Search" as covering /AgendaCenter/Search', () => {
    // Prefix matching is anchored at the path root, so the site-search ban does not
    // reach the AgendaCenter's own search. The adapter does not use it either way.
    expect(isAllowedByRobots(rules, '/AgendaCenter/Search/?term=')).toBe(true);
  });

  it('prefers a group naming us over the wildcard group', () => {
    const specific = parseRobotsTxt(
      ['User-agent: *', 'Disallow: /', '', 'User-agent: CommissionWatch', 'Allow: /'].join('\n'),
      'CommissionWatch/0.1',
    );
    expect(isAllowedByRobots(specific, '/AgendaCenter')).toBe(true);
  });

  it('lets the longest match win, and Allow win a tie', () => {
    const nested = parseRobotsTxt(
      ['User-agent: *', 'Disallow: /a', 'Allow: /a/b'].join('\n'),
      'CommissionWatch/0.1',
    );
    expect(isAllowedByRobots(nested, '/a/x')).toBe(false);
    expect(isAllowedByRobots(nested, '/a/b/c')).toBe(true);
  });
});

describe('gallatin-civicplus discovery', () => {
  const now = (): Date => new Date('2026-08-04T12:00:00Z');

  async function discover(since: Date) {
    const { transport, requests } = createFixtureTransport();
    const adapter = createGallatinCivicPlusAdapter({ transport, now });
    const meetings = await adapter.discoverMeetings(since);
    return { meetings, requests, adapter };
  }

  it('walks the year links instead of trusting the index alone', async () => {
    const { meetings, requests } = await discover(new Date('2025-01-01T00:00:00Z'));

    // 8 rows are rendered on the index; Weed Board's 2025 tab holds 10 more.
    expect(meetings).toHaveLength(18);

    const posts = requests.filter((request) => request.method === 'POST');
    expect(posts.map((request) => new URLSearchParams(request.body ?? '').get('catID'))).toEqual([
      '4',
    ]);
    expect(posts.map((request) => new URLSearchParams(request.body ?? '').get('year'))).toEqual([
      '2025',
    ]);
  });

  it('does not request years that end before `since`', async () => {
    // Big Sky offers 2022, and Weed Board offers 2018-2024. A 2026 sweep wants none.
    const { meetings, requests } = await discover(new Date('2026-01-01T00:00:00Z'));
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(0);
    expect(meetings.every((meeting) => meeting.date >= '2026-01-01')).toBe(true);
    expect(meetings).toHaveLength(7);
  });

  it('attributes each meeting to the category it was listed under', async () => {
    const { meetings } = await discover(new Date('2025-01-01T00:00:00Z'));
    const bigSky = meetings.find((meeting) => meeting.externalId === '06022025-2');
    expect(bigSky?.bodyKey).toBe('big-sky-meadow-trails-recreation-parks-special-district');
    expect(meetings.find((meeting) => meeting.externalId === '12042025-101')?.bodyKey).toBe(
      'weed-board',
    );
    expect(meetings.find((meeting) => meeting.externalId === '04102026-1')?.bodyKey).toBe(
      'study-commission',
    );
  });

  it('states no meeting time or location, because AgendaCenter states none', async () => {
    const { meetings } = await discover(new Date('2025-01-01T00:00:00Z'));
    expect(meetings.length).toBeGreaterThan(0);
    for (const meeting of meetings) {
      expect(meeting.time).toBeUndefined();
      expect(meeting.location).toBeUndefined();
      expect(meeting.timezone).toBe('America/Denver');
    }
  });

  it('marks future meetings scheduled and past ones completed', async () => {
    const { meetings } = await discover(new Date('2025-01-01T00:00:00Z'));
    const future = meetings.find((meeting) => meeting.externalId === '08062026-108');
    expect(future?.date).toBe('2026-08-06');
    expect(future?.status).toBe('scheduled');
    expect(meetings.find((meeting) => meeting.externalId === '06022025-2')?.status).toBe(
      'completed',
    );
  });

  it('returns a stable, newest-first order', async () => {
    const first = await discover(new Date('2025-01-01T00:00:00Z'));
    const second = await discover(new Date('2025-01-01T00:00:00Z'));
    expect(second.meetings).toEqual(first.meetings);
    const dates = first.meetings.map((meeting) => meeting.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('carries provenance and this adapter key on every ref and document', async () => {
    const { meetings } = await discover(new Date('2025-01-01T00:00:00Z'));
    for (const meeting of meetings) {
      expect(meeting.sourceKey).toBe(GALLATIN_ADAPTER_KEY);
      expect(meeting.sourceUrl).toBe(GALLATIN_AGENDA_CENTER_URL);
      for (const document of meeting.documents) {
        expect(document.sourceKey).toBe(GALLATIN_ADAPTER_KEY);
        expect(document.meetingExternalId).toBe(meeting.externalId);
        expect(document.url.startsWith(`${GALLATIN_ORIGIN}/AgendaCenter/ViewFile/`)).toBe(true);
      }
    }
  });

  it('reads robots.txt once and before anything else', async () => {
    const { requests } = await discover(new Date('2025-01-01T00:00:00Z'));
    expect(requests[0].url).toBe(GALLATIN_ROBOTS_URL);
    expect(requests.filter((request) => request.url === GALLATIN_ROBOTS_URL)).toHaveLength(1);
  });

  it('declares only the origin it actually requests', async () => {
    const { requests, adapter } = await discover(new Date('2025-01-01T00:00:00Z'));
    const declared = new Set(adapter.describeSource().baseUrls.map((url) => new URL(url).origin));
    for (const request of requests) {
      expect(declared.has(new URL(request.url).origin)).toBe(true);
    }
  });

  it('skips an unconfigured category loudly rather than silently', async () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: string) => {
      warnings.push(message);
    };
    try {
      const { transport } = createFixtureTransport();
      const adapter = createGallatinCivicPlusAdapter({
        transport,
        now,
        // Weed Board (4) deliberately left out of the configured list.
        bodies: [{ catId: 3, name: 'Big Sky Meadow Trails, Recreation & Parks Special District' }],
      });
      const meetings = await adapter.discoverMeetings(new Date('2025-01-01T00:00:00Z'));
      expect(meetings.map((meeting) => meeting.externalId)).toEqual(['06022025-2']);
      expect(warnings.some((message) => message.includes('category 4'))).toBe(true);
      expect(warnings.some((message) => message.includes('category 2'))).toBe(true);
    } finally {
      console.warn = warn;
    }
  });

  it('declares a two-second delay, four times the contract floor', () => {
    const adapter = createGallatinCivicPlusAdapter({
      transport: createFixtureTransport().transport,
    });
    expect(adapter.describeSource().politeness.minDelayMs).toBe(GALLATIN_MIN_DELAY_MS);
    expect(GALLATIN_MIN_DELAY_MS).toBe(2000);
    expect(adapter.describeSource().politeness.maxConcurrency).toBe(1);
  });
});

describe('gallatin-civicplus fetchDocument', () => {
  const ref: DocumentRef = contractDocumentRef;

  function build(cache?: DocumentCache) {
    const { transport, requests } = createFixtureTransport();
    return {
      requests,
      adapter: createGallatinCivicPlusAdapter({ transport, documentCache: cache }),
    };
  }

  it('content-addresses the captured PDF with the sha recorded at capture time', async () => {
    const { adapter } = build();
    const artifact = await adapter.fetchDocument(ref);
    expect(artifact.sha256).toBe(PDF_SHA256);
    expect(artifact.byteSize).toBe(74045);
    expect(artifact.contentType).toBe('application/pdf');
    expect(artifact.sourceUrl).toBe(PDF_URL);
    expect(Buffer.from(artifact.bytes.subarray(0, 5)).toString()).toBe('%PDF-');
  });

  it('does not re-fetch a document it already holds', async () => {
    const { adapter, requests } = build();
    const first = await adapter.fetchDocument(ref);
    const second = await adapter.fetchDocument(ref);
    expect(second.sha256).toBe(first.sha256);
    expect(requests.filter((request) => request.url === PDF_URL)).toHaveLength(1);
  });

  it('hands out a copy, so a caller cannot corrupt the cache', async () => {
    const { adapter } = build();
    const first = await adapter.fetchDocument(ref);
    first.bytes[0] = 0;
    const second = await adapter.fetchDocument(ref);
    expect(second.sha256).toBe(PDF_SHA256);
  });

  it('revalidates with If-None-Match when a validator is known and honours 304', async () => {
    // Gallatin sends no ETag today. This proves the adapter would use one if it did.
    const bytes = fixture('viewfile-agenda-06022025-2.pdf');
    const seeded: CachedDocument = {
      bytes,
      contentType: 'application/pdf',
      sourceUrl: PDF_URL,
      etag: 'W/"abc123"',
    };
    const cache = createMemoryDocumentCache();
    cache.set(PDF_URL, seeded);

    const seen: HttpRequest[] = [];
    const transport: HttpTransport = async (request) => {
      seen.push(request);
      if (request.url === GALLATIN_ROBOTS_URL) {
        return {
          status: 200,
          headers: {},
          bytes: fixture('robots.txt'),
          finalUrl: request.url,
        };
      }
      return { status: 304, headers: {}, bytes: new Uint8Array(0), finalUrl: request.url };
    };

    const adapter = createGallatinCivicPlusAdapter({ transport, documentCache: cache });
    const artifact = await adapter.fetchDocument(ref);

    expect(seen.at(-1)?.headers?.['If-None-Match']).toBe('W/"abc123"');
    expect(artifact.sha256).toBe(PDF_SHA256);
    expect(artifact.byteSize).toBe(74045);
  });

  it('refuses a URL outside the declared surface', async () => {
    const { adapter } = build();
    await expect(
      adapter.fetchDocument({ ...ref, url: 'https://example.invalid/agenda.pdf' }),
    ).rejects.toBeInstanceOf(OffSourceUrlError);
  });

  it('refuses a URL robots.txt disallows', async () => {
    const { adapter } = build();
    await expect(
      adapter.fetchDocument({ ...ref, url: `${GALLATIN_ORIGIN}/admin/secret.pdf` }),
    ).rejects.toBeInstanceOf(RobotsDisallowedError);
  });

  it('surfaces a non-200 rather than returning empty bytes', async () => {
    const transport: HttpTransport = async (request) => {
      if (request.url === GALLATIN_ROBOTS_URL) {
        return { status: 200, headers: {}, bytes: fixture('robots.txt'), finalUrl: request.url };
      }
      return { status: 503, headers: {}, bytes: new Uint8Array(0), finalUrl: request.url };
    };
    const adapter = createGallatinCivicPlusAdapter({ transport });
    await expect(adapter.fetchDocument(ref)).rejects.toBeInstanceOf(HttpStatusError);
  });
});

describe('createPoliteTransport', () => {
  const okFetch: FetchLike = async () =>
    new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });

  it('waits the declared delay between requests', async () => {
    const slept: number[] = [];
    let clock = 0;
    const transport = createPoliteTransport({
      minDelayMs: 2000,
      fetchImpl: okFetch,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });

    await transport({ url: `${GALLATIN_ORIGIN}/a`, method: 'GET' });
    await transport({ url: `${GALLATIN_ORIGIN}/b`, method: 'GET' });
    await transport({ url: `${GALLATIN_ORIGIN}/c`, method: 'GET' });

    // Nothing before the first request; a full gap before each one after it.
    expect(slept).toEqual([2000, 2000]);
  });

  it('sends the honest user agent', async () => {
    const seen: FetchLikeInit[] = [];
    const recording: FetchLike = async (_url, init) => {
      seen.push(init);
      return new Response('ok', { status: 200 });
    };
    const transport = createPoliteTransport({
      fetchImpl: recording,
      sleep: async () => undefined,
    });
    await transport({ url: `${GALLATIN_ORIGIN}/a`, method: 'GET' });

    expect(seen[0].headers['User-Agent']).toMatch(/^CommissionWatch\//);
    expect(seen[0].headers['User-Agent']).toContain('commissionwatch.bmux.sh');
    // No browser impersonation anywhere in it.
    expect(seen[0].headers['User-Agent']).not.toMatch(/mozilla|chrome|safari/i);
  });

  it('form-encodes the one POST the source takes', async () => {
    const seen: FetchLikeInit[] = [];
    const recording: FetchLike = async (_url, init) => {
      seen.push(init);
      return new Response('ok', { status: 200 });
    };
    const transport = createPoliteTransport({
      fetchImpl: recording,
      sleep: async () => undefined,
    });
    await transport({
      url: GALLATIN_UPDATE_CATEGORY_URL,
      method: 'POST',
      body: 'year=2025&catID=4',
    });

    expect(seen[0].body).toBe('year=2025&catID=4');
    expect(seen[0].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('keeps serving after a request fails', async () => {
    // The guarantee this has always been about: one failed request must not
    // poison the serialising chain behind it. Pinned with retries off, so it
    // tests the chain rather than the retry policy layered over it.
    let call = 0;
    const flaky: FetchLike = async () => {
      call += 1;
      if (call === 1) throw new Error('boom');
      return new Response('ok', { status: 200 });
    };
    const transport = createPoliteTransport({
      fetchImpl: flaky,
      sleep: async () => undefined,
      maxRetries: 0,
    });

    await expect(transport({ url: `${GALLATIN_ORIGIN}/a`, method: 'GET' })).rejects.toThrow(
      /boom/,
    );
    const second = await transport({ url: `${GALLATIN_ORIGIN}/b`, method: 'GET' });
    expect(second.status).toBe(200);
  });

  it('retries a transport failure and succeeds on the second attempt', async () => {
    let call = 0;
    const flaky: FetchLike = async () => {
      call += 1;
      if (call === 1) throw new Error('boom');
      return new Response('ok', { status: 200 });
    };
    const transport = createPoliteTransport({ fetchImpl: flaky, sleep: async () => undefined });

    const response = await transport({ url: `${GALLATIN_ORIGIN}/a`, method: 'GET' });

    expect(response.status).toBe(200);
    expect(call).toBe(2);
  });

  it('names the URL and the elapsed time when a request runs out of attempts', async () => {
    // The whole reason this error class exists: production logged
    // "AbortError: This operation was aborted" with no URL, no elapsed time and
    // no way to tell which of a dozen requests had been in flight.
    const dead: FetchLike = async () => {
      throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    };
    const transport = createPoliteTransport({ fetchImpl: dead, sleep: async () => undefined });

    await expect(transport({ url: `${GALLATIN_ORIGIN}/slow`, method: 'GET' })).rejects.toThrow(
      /gallatinmt\.gov\/slow failed after \d+ms \(3 attempts, \d+ms timeout\): AbortError/,
    );
  });

  it('waits out a Retry-After rather than pressing on', async () => {
    // "Sleep if needed to not get blocked" — a 429 is the server saying exactly
    // how long to wait, and honouring it is cheaper than being banned.
    const slept: number[] = [];
    let call = 0;
    const limited: FetchLike = async () => {
      call += 1;
      if (call === 1) {
        return new Response('slow down', { status: 429, headers: { 'Retry-After': '7' } });
      }
      return new Response('ok', { status: 200 });
    };
    const transport = createPoliteTransport({
      fetchImpl: limited,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    const response = await transport({ url: `${GALLATIN_ORIGIN}/a`, method: 'GET' });

    expect(response.status).toBe(200);
    expect(slept).toContain(7000);
  });

  it('never backs off faster than it crawls', async () => {
    // A Retry-After shorter than the politeness delay must not become licence
    // to go quicker than the crawl rate we publish.
    const slept: number[] = [];
    let call = 0;
    const limited: FetchLike = async () => {
      call += 1;
      if (call === 1) return new Response('', { status: 503 });
      return new Response('ok', { status: 200 });
    };
    // A clock that advances when the transport sleeps, so the politeness gap is
    // measured against simulated time rather than against a wall clock that
    // never moved.
    let clock = 1_000_000;
    const transport = createPoliteTransport({
      fetchImpl: limited,
      minDelayMs: 2000,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });

    await transport({ url: `${GALLATIN_ORIGIN}/a`, method: 'GET' });

    expect(slept.every((ms) => ms >= 2000)).toBe(true);
  });

  it('hands the adapter the real status when the server never relents', async () => {
    // Returned, not thrown: a 429 that outlives our retries is a fact about the
    // server, and the adapter decides what it means.
    const limited: FetchLike = async () => new Response('', { status: 429 });
    const transport = createPoliteTransport({
      fetchImpl: limited,
      sleep: async () => undefined,
      maxRetries: 1,
    });

    const response = await transport({ url: `${GALLATIN_ORIGIN}/a`, method: 'GET' });

    expect(response.status).toBe(429);
  });
});


describe('parseRetryAfter', () => {
  const NOW = Date.parse('2026-08-16T12:00:00.000Z');

  it('reads delta-seconds', () => {
    expect(parseRetryAfter('120', NOW)).toBe(120_000);
  });

  it('reads an HTTP-date as the remaining wait', () => {
    expect(parseRetryAfter('Sun, 16 Aug 2026 12:00:30 GMT', NOW)).toBe(30_000);
  });

  it('returns null for a date already in the past', () => {
    // Not zero. Zero would read as "retry immediately", which is how a rate
    // limit becomes a hammering.
    expect(parseRetryAfter('Sun, 16 Aug 2026 11:59:00 GMT', NOW)).toBe(null);
  });

  it('returns null for absent or unreadable headers rather than guessing', () => {
    expect(parseRetryAfter(undefined, NOW)).toBe(null);
    expect(parseRetryAfter('', NOW)).toBe(null);
    expect(parseRetryAfter('soon please', NOW)).toBe(null);
    expect(parseRetryAfter('-5', NOW)).toBe(null);
  });
});
