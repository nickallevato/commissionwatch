import { describe, it } from 'node:test';
import { expect } from '../helpers/expect';
import { createTapeTransport, loadTape } from '../helpers/cers-tape';
import {
  CAMPAIGN_TYPE_COUNTY,
  COUNTY_COMMISSIONER_OFFICE_CODE,
  EMPTY_SESSION,
  GALLATIN_COUNTY_CODE,
  RECORD_KIND_CANDIDATE_ROSTER,
  RECORD_KIND_REPORT_INDEX,
  RECORD_KIND_REPORT_SCHEDULE,
  advanceSession,
  cersExchangeKey,
  createMtCersAdapter,
  rotateWindow,
  dataTablesQuery,
  expectJson,
  isEmptyBody,
  parseEnvelope,
  parseLineItems,
  recordUrl,
  toCandidate,
  type CersAdapterOptions,
} from '../../src/services/ingestion/adapters/mt-cers';
import { runAdapterContract } from './contract';

/**
 * The mt-cers adapter, against the recorded tape.
 *
 * Every byte here came off `cers-ext.mt.gov` on 2026-08-10 by driving this same
 * adapter at 2.5-second intervals; see `../fixtures/mt-cers/PROVENANCE.md`.
 * Nothing in this file reaches the network — an unrecorded request throws.
 */

const TAPE = loadTape();

const GALLATIN_COMMISSIONER = {
  key: 'gallatin-county-commissioner',
  label: 'Gallatin County Commissioner',
  campaignType: CAMPAIGN_TYPE_COUNTY,
  countyCode: GALLATIN_COUNTY_CODE,
  officeCode: COUNTY_COMMISSIONER_OFFICE_CODE,
};

function buildAdapter(overrides: CersAdapterOptions = {}) {
  return createMtCersAdapter({
    transport: createTapeTransport(TAPE),
    targets: [GALLATIN_COMMISSIONER],
    schedules: ['individual', 'expendOther'],
    maxCandidatesPerTarget: 2,
    maxReportsPerCandidate: 2,
    now: () => new Date('2026-08-10T05:28:15.261Z'),
    // Pinned: the tape recorded a specific set of candidates, and a window that
    // moved with the calendar would make this suite pass or fail by date.
    rosterOffset: 0,
    ...overrides,
  });
}

const SINCE = new Date('2026-01-01T00:00:00Z');

runAdapterContract(buildAdapter(), {
  since: SINCE,
  emitsMeetings: false,
});

describe('mt-cers descriptor', () => {
  const descriptor = buildAdapter().describeSource();

  it('is a state jurisdiction, because CERS is neither a city nor a county', () => {
    expect(descriptor.jurisdiction.type).toBe('state');
    expect(descriptor.jurisdiction.name).toBe('State of Montana');
    expect(descriptor.jurisdiction.state).toBe('MT');
  });

  it('declares no bodies, because CERS publishes no meetings', () => {
    expect(descriptor.bodies).toEqual([]);
  });

  it('fetches no faster than one request every five seconds, never concurrently', () => {
    // Slower than every other adapter, because this host publishes no
    // robots.txt: there is no stated rate to honour, so we err slower rather
    // than assuming the general default was meant for us.
    expect(descriptor.politeness.minDelayMs).toBeGreaterThanOrEqual(5000);
    expect(descriptor.politeness.maxConcurrency).toBe(1);
  });

  it('respects robots.txt by default even though the host publishes none', () => {
    // If one ever appears it is honoured because the default already says so,
    // rather than because somebody notices and decides.
    expect(descriptor.politeness.respectRobotsTxt).toBe(true);
  });

  it('records in its notes that no access exception is claimed', () => {
    expect(descriptor.notes).toMatch(/no robots\.txt/i);
    expect(descriptor.notes).toMatch(/no bulk download/i);
  });

  it('supports live fetching', () => {
    expect(descriptor.supportsLiveFetch).toBe(true);
  });
});

describe('mt-cers discovery', () => {
  it('discovers no meetings, and that is the record rather than a gap', async () => {
    expect(await buildAdapter().discoverMeetings()).toEqual([]);
  });

  it('emits a roster, a report index per candidate, and a schedule per report', async () => {
    const refs = await buildAdapter().discoverDocuments(SINCE);
    const kinds = refs.map((ref) => ref.metadata?.recordKind);
    expect(kinds.filter((kind) => kind === RECORD_KIND_CANDIDATE_ROSTER).length).toBe(1);
    expect(kinds.filter((kind) => kind === RECORD_KIND_REPORT_INDEX).length).toBe(2);
    // Two candidates: one with two reports walked, one with a single filing.
    // 2 schedules each.
    expect(kinds.filter((kind) => kind === RECORD_KIND_REPORT_SCHEDULE).length).toBe(6);
  });

  it('carries the chain a schedule is addressed by', async () => {
    const refs = await buildAdapter().discoverDocuments(SINCE);
    const schedule = refs.find(
      (ref) => ref.metadata?.recordKind === RECORD_KIND_REPORT_SCHEDULE,
    );
    expect(schedule).toBeDefined();
    const metadata = schedule?.metadata ?? {};
    expect(metadata.candidateId).toBeDefined();
    expect(metadata.reportId).toBeDefined();
    expect(['individual', 'expendOther']).toContain(metadata.schedule);
    // The identity is the endpoint plus those parameters, so two schedules of
    // the same report are two different records rather than one.
    expect(schedule?.url).toMatch(/financeRepDetailList\?/);
  });

  it('honours the candidate cap, because a statewide system is not a sweep target', async () => {
    const refs = await buildAdapter({ maxCandidatesPerTarget: 1 }).discoverDocuments(SINCE);
    const indexes = refs.filter(
      (ref) => ref.metadata?.recordKind === RECORD_KIND_REPORT_INDEX,
    );
    expect(indexes.length).toBe(1);
  });

  it('reads 42 Gallatin County Commissioner candidacies out of the roster', async () => {
    const adapter = buildAdapter();
    const refs = await adapter.discoverDocuments(SINCE);
    const roster = refs.find((ref) => ref.metadata?.recordKind === RECORD_KIND_CANDIDATE_ROSTER);
    expect(roster).toBeDefined();
    expect(roster?.title).toMatch(/42 records/);
  });
});

describe('mt-cers fetch', () => {
  it('stores the JSON bytes and content-addresses them', async () => {
    const adapter = buildAdapter();
    const refs = await adapter.discoverDocuments(SINCE);
    const schedule = refs.find(
      (ref) =>
        ref.metadata?.recordKind === RECORD_KIND_REPORT_SCHEDULE &&
        ref.metadata.schedule === 'individual',
    );
    expect(schedule).toBeDefined();
    if (schedule === undefined) return;

    const artifact = await adapter.fetchDocument(schedule);
    expect(artifact.contentType).toBe('application/json');
    expect(artifact.byteSize).toBeGreaterThan(0);
    // The identity, not the POST endpoint: every schedule of every candidate
    // would otherwise record the same source_url.
    expect(artifact.sourceUrl).toBe(schedule.url);
    const payload = expectJson(artifact.bytes, artifact.sourceUrl);
    expect(Array.isArray(payload)).toBe(true);
  });

  it('reads real itemised contributions with donor, date and amount', async () => {
    const adapter = buildAdapter();
    const refs = await adapter.discoverDocuments(SINCE);
    const schedules = refs.filter(
      (ref) =>
        ref.metadata?.recordKind === RECORD_KIND_REPORT_SCHEDULE &&
        ref.metadata.schedule === 'individual',
    );

    let total = 0;
    let withDonor = 0;
    let withAmount = 0;
    for (const ref of schedules) {
      const artifact = await adapter.fetchDocument(ref);
      const items = parseLineItems(expectJson(artifact.bytes, ref.url), ref.url);
      total += items.length;
      withDonor += items.filter((item) => item.entityName !== null).length;
      withAmount += items.filter((item) => item.totalAmt !== null).length;
    }
    expect(total).toBeGreaterThan(0);
    // The civic core. A contribution this project cannot name, date or price is
    // not a disclosure, and `vote_donor_conflict` has nothing to correlate.
    expect(withDonor).toBeGreaterThan(0);
    expect(withAmount).toBeGreaterThan(0);
  });

  it('does not carry the donor PII the response contains', async () => {
    // CERS returns entityAddress, occupationDescr and employerDescr on every
    // contribution row. The raw body still has them — this asserts the *parser*
    // drops them, which is what stops them reaching a writer. The paired schema
    // and fixture guards are in `test/finance-pii-guard.test.ts`.
    const adapter = buildAdapter();
    const refs = await adapter.discoverDocuments(SINCE);
    const schedules = refs.filter(
      (ref) =>
        ref.metadata?.recordKind === RECORD_KIND_REPORT_SCHEDULE &&
        ref.metadata.schedule === 'individual',
    );

    let inspected = 0;
    for (const ref of schedules) {
      const artifact = await adapter.fetchDocument(ref);
      const payload = expectJson(artifact.bytes, ref.url);
      const items = parseLineItems(payload, ref.url);
      for (const item of items) {
        inspected += 1;
        for (const field of ['entityAddress', 'occupationDescr', 'employerDescr']) {
          expect(Object.prototype.hasOwnProperty.call(item, field)).toBe(false);
        }
      }
    }
    // A scan that matched no rows would pass forever.
    expect(inspected).toBeGreaterThan(0);
  });

  it('accepts an empty schedule as a real answer, not a failure', async () => {
    // A filed report with no itemised contributions is a common state, and the
    // tape keeps two of them for exactly this assertion.
    const adapter = buildAdapter();
    const refs = await adapter.discoverDocuments(SINCE);
    const empty: number[] = [];
    for (const ref of refs.filter(
      (candidate) => candidate.metadata?.recordKind === RECORD_KIND_REPORT_SCHEDULE,
    )) {
      const artifact = await adapter.fetchDocument(ref);
      const items = parseLineItems(expectJson(artifact.bytes, ref.url), ref.url);
      if (items.length === 0) empty.push(artifact.byteSize);
    }
    expect(empty.length).toBeGreaterThan(0);
  });

  it('refuses a ref it does not know how to address', async () => {
    const adapter = buildAdapter();
    await expect(
      adapter.fetchDocument({
        sourceKey: 'mt-cers',
        kind: 'other',
        title: 'nonsense',
        url: 'https://cers-ext.mt.gov/CampaignTracker/public/whatever',
        metadata: { recordKind: 'not-a-cers-record' },
      }),
    ).rejects.toThrow(/unknown metadata.recordKind/);
  });

  it('refuses a ref outside its declared surface', async () => {
    const adapter = buildAdapter();
    await expect(
      adapter.fetchDocument({
        sourceKey: 'mt-cers',
        kind: 'other',
        title: 'elsewhere',
        url: 'https://example.com/CampaignTracker/public/x',
        metadata: { recordKind: RECORD_KIND_CANDIDATE_ROSTER },
      }),
    ).rejects.toThrow(/outside the declared surface/);
  });

  it('never reaches the network: an unrecorded request throws', async () => {
    const adapter = createMtCersAdapter({
      transport: createTapeTransport(TAPE),
      targets: [{ ...GALLATIN_COMMISSIONER, countyCode: '3273' }],
    });
    await expect(adapter.discoverDocuments(SINCE)).rejects.toThrow(
      /No recorded CERS exchange/,
    );
  });
});

describe('mt-cers empty bodies', () => {
  it('tells an empty body apart from a short body that is not JSON', () => {
    // The first real sweep failed a job on this: CERS answers 200 with zero
    // bytes for a schedule that does not apply. Nothing to parse is not the
    // same as something unparseable — a WAF interstitial is the second, and
    // must still throw.
    expect(isEmptyBody(new Uint8Array(0))).toBe(true);
    expect(isEmptyBody(new TextEncoder().encode('   \n'))).toBe(true);
    expect(isEmptyBody(new TextEncoder().encode('[]'))).toBe(false);
    expect(isEmptyBody(new TextEncoder().encode('<html>'))).toBe(false);
  });
});

describe('mt-cers roster paging', () => {
  it('makes each page its own record, because two pages are two documents', async () => {
    const refs = await buildAdapter().discoverDocuments(SINCE);
    const roster = refs.filter(
      (ref) => ref.metadata?.recordKind === RECORD_KIND_CANDIDATE_ROSTER,
    );
    // 42 Gallatin County Commissioner candidacies fit in one 100-row page.
    expect(roster.length).toBe(1);
    expect(roster[0]?.metadata?.start).toBe('0');
    // The offset is part of the identity. Without it every page of a 342-row
    // roster would collide on one URL — which is how the first real sweep
    // wrote 142 filers against 384 that exist.
    expect(roster[0]?.url).toMatch(/start=0/);
  });
});

describe('mt-cers session protocol', () => {
  it('a search resets the candidate and report the session held', () => {
    const after = advanceSession(
      { search: 'old', candidateId: '1', reportId: '2' },
      {
        url: 'https://cers-ext.mt.gov/CampaignTracker/public/searchResults/searchCandidates',
        method: 'POST',
        body: 'countyCode=3257',
      },
    );
    expect(after).toEqual({ search: 'countyCode=3257', candidateId: '', reportId: '' });
  });

  it('selecting a candidate clears the report, because the old one is not theirs', () => {
    const after = advanceSession(
      { search: 's', candidateId: '1', reportId: '2' },
      {
        url: 'https://cers-ext.mt.gov/CampaignTracker/public/publicReportList/retrieveCampaignReports',
        method: 'POST',
        body: 'candidateId=9&searchPage=public',
      },
    );
    expect(after).toEqual({ search: 's', candidateId: '9', reportId: '' });
  });

  it('keys the same request differently when the session is somewhere else', () => {
    const request = {
      url: 'https://cers-ext.mt.gov/CampaignTracker/public/viewFinanceReport/financeRepDetailList',
      method: 'POST' as const,
      body: 'listName=individual',
    };
    // This is the whole reason the tape is keyed on position. The two calls are
    // byte-identical and return different candidates' contributions.
    const here = cersExchangeKey({ search: '', candidateId: '1', reportId: '10' }, request);
    const there = cersExchangeKey({ search: '', candidateId: '2', reportId: '20' }, request);
    expect(here).not.toBe(there);
  });

  it('ignores the session id and the DataTables cache-buster in the key', () => {
    const plain = cersExchangeKey(EMPTY_SESSION, {
      url: 'https://cers-ext.mt.gov/CampaignTracker/public/search',
      method: 'GET',
    });
    const rewritten = cersExchangeKey(EMPTY_SESSION, {
      url: 'https://cers-ext.mt.gov/CampaignTracker/public/search;jsessionid=DEADBEEF',
      method: 'GET',
    });
    expect(rewritten).toBe(plain);
  });
});

describe('mt-cers response narrowing', () => {
  it('refuses a non-JSON body rather than trying to parse it', () => {
    // The hard line: an unexpected body is a signal to stop, not a new format
    // to support. A WAF challenge arrives looking exactly like this.
    const html = new TextEncoder().encode('<html><body>Access Denied</body></html>');
    expect(() => expectJson(html, 'https://example.test/x')).toThrow(/non-JSON body/);
    expect(() => expectJson(html, 'https://example.test/x')).toThrow(/Access Denied/);
  });

  it('rejects a payload that is not a DataTables envelope', () => {
    expect(() => parseEnvelope({ nope: true }, 'u', toCandidate)).toThrow(/aaData/);
  });

  it('rejects a schedule payload that is not an array', () => {
    expect(() => parseLineItems({ aaData: [] }, 'u')).toThrow(/array of line items/);
  });

  it('builds a stable record identity regardless of parameter order', () => {
    const one = recordUrl('public/x', { b: '2', a: '1' });
    const two = recordUrl('public/x', { a: '1', b: '2' });
    expect(one).toBe(two);
  });

  it('asks for pages the endpoint understands', () => {
    const query = new URLSearchParams(dataTablesQuery(0, 100, 9));
    expect(query.get('iDisplayLength')).toBe('100');
    expect(query.get('iColumns')).toBe('9');
    expect(query.get('mDataProp_8')).toBe('8');
  });
});


describe('rotateWindow', () => {
  const roster = Array.from({ length: 42 }, (_, i) => i);

  it('takes the first slice at offset zero', () => {
    expect(rotateWindow(roster, 5, 0)).toEqual([0, 1, 2, 3, 4]);
  });

  it('moves the window, so a later candidate is not unreachable', () => {
    // The defect this replaced: the cap took the first N of an alphabetically
    // ordered roster, so candidate six of forty-two could never be swept.
    expect(rotateWindow(roster, 5, 5)).toEqual([5, 6, 7, 8, 9]);
  });

  it('wraps past the end rather than returning a short window', () => {
    expect(rotateWindow(roster, 5, 40)).toEqual([40, 41, 0, 1, 2]);
  });

  it('reaches every candidate across a cycle of sweeps', () => {
    // The guarantee that matters. Not that a cycle sees each candidate exactly
    // once — the roster can change length between sweeps — but that none is
    // permanently invisible.
    const seen = new Set<number>();
    for (let sweep = 0; sweep < 9; sweep += 1) {
      for (const candidate of rotateWindow(roster, 5, sweep * 5)) seen.add(candidate);
    }
    expect(seen.size).toBe(42);
  });

  it('returns the whole list when it is smaller than the window', () => {
    expect(rotateWindow([1, 2], 5, 99)).toEqual([1, 2]);
  });

  it('handles an empty roster and a zero window without inventing rows', () => {
    expect(rotateWindow([], 5, 3)).toEqual([]);
    expect(rotateWindow(roster, 0, 3)).toEqual([]);
  });

  it('never returns a different length for the same inputs', () => {
    for (let offset = 0; offset < 50; offset += 1) {
      expect(rotateWindow(roster, 5, offset).length).toBe(5);
    }
  });
});
