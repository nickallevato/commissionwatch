import {
  COMMISSIONWATCH_USER_AGENT,
  HttpStatusError,
  OffSourceUrlError,
  createPoliteTransport,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from './http';
import {
  sha256Hex,
  type DocumentRef,
  type FetchedArtifact,
  type MeetingRef,
  type SourceAdapter,
  type SourceDescriptor,
} from './types';

/**
 * Montana CERS — the Campaign Electronic Reporting System, run by the
 * Commissioner of Political Practices at `cers-ext.mt.gov/CampaignTracker`.
 *
 * Access findings, with dates, status codes and response shapes:
 * `docs/exploration/mt-cers-spike.md`. The short version:
 *
 *  - The host publishes **no `robots.txt`** — `/robots.txt` is a Tomcat 404, not
 *    a `Disallow`. Nothing here relies on the vendor-robots exception of
 *    2026-08-04, and nothing here needs disclosing on the Methodology page.
 *  - There is **no login, no CAPTCHA, no challenge and no UA discrimination**.
 *    Every request below was answered first time to the honest project agent.
 *  - There is **no bulk route**: no CSV, no export, no documented API. The
 *    structure is a server-side DataTables JSON API, walked entity by entity.
 *
 * ## Why this source exists at all
 *
 * OpenFEC covers federal candidates. A Gallatin County Commissioner and a
 * Bozeman City Commissioner have no federal filings whatsoever, so without CERS
 * this project can say nothing about the money behind the officials it actually
 * watches. This is the campaign-finance source for local office.
 *
 * ## The shape of the thing, and why a document ref carries a request chain
 *
 * CERS keeps a search's criteria in the **HTTP session**. The POST that runs a
 * search returns a page of empty table shells; the rows arrive from a separate
 * GET that carries no criteria of its own and reads what the POST left behind.
 * A crawler that read the POST's HTML would conclude the site holds nothing.
 *
 * So a CERS record is not addressed by a URL. It is addressed by a *chain*:
 * establish a session, select a candidate, open a filed report, ask for one of
 * its schedules. {@link DocumentRef.metadata} carries that chain's parameters,
 * and {@link CersAdapter.fetchDocument} replays exactly them. `ref.url` is the
 * endpoint with those parameters rendered as a query string — a faithful,
 * stable, human-readable identity for the record, and the same string every
 * time, which is what `meeting_documents (meeting_id, url)` and the console
 * both need. It is not a URL you can paste into a browser, and the comment
 * saying so is here rather than in a commit message because somebody will try.
 *
 * ## The hard line
 *
 * The host sets two F5 BIG-IP ASM cookies alongside `JSESSIONID`. A WAF is
 * present and stayed entirely silent across the spike. **If it ever challenges
 * — an interstitial, a JS puzzle, a fingerprint check — this adapter must stop
 * and report, not adapt.** That is why {@link expectJson} treats a non-JSON body
 * as a failure with the first bytes quoted, instead of falling back to parsing
 * HTML: a fallback here is how "we were blocked" quietly becomes "we worked
 * around it".
 *
 * ## One operational limit that is not a block
 *
 * An unbounded contributor-side search timed out after 60 seconds during the
 * spike. That is an expensive query on their side, not a defence, and the
 * design consequence is firm: **every query this adapter issues is scoped to a
 * county and a campaign type, and then to one candidate.** It never asks CERS an
 * open question.
 */

const BASE_URL = 'https://cers-ext.mt.gov/CampaignTracker';
const ORIGIN = 'https://cers-ext.mt.gov';

/** Gallatin County's `countyCode` in the search form's own select. */
export const GALLATIN_COUNTY_CODE = '3257';

/** `officeCode` for County Commissioner, from the 275-entry office select. */
export const COUNTY_COMMISSIONER_OFFICE_CODE = '29';

/**
 * `candidateTypeCode` values. CERS calls these campaign types.
 *
 * `CT` is every municipal office in the county, not just Bozeman's — see
 * {@link CersCandidate} on why there is no city field to filter by.
 */
export const CAMPAIGN_TYPE_COUNTY = 'CN';
export const CAMPAIGN_TYPE_CITY = 'CT';

/** The schedules of a filed report this adapter reads. */
export const CONTRIBUTION_SCHEDULES = ['individual', 'committee'] as const;
export const EXPENDITURE_SCHEDULES = ['expendOther', 'expendIndependent'] as const;

export type CersSchedule =
  | (typeof CONTRIBUTION_SCHEDULES)[number]
  | (typeof EXPENDITURE_SCHEDULES)[number];

const ALL_SCHEDULES: readonly CersSchedule[] = Object.freeze([
  ...CONTRIBUTION_SCHEDULES,
  ...EXPENDITURE_SCHEDULES,
]);

/** `metadata.recordKind` values this adapter emits. */
export const RECORD_KIND_CANDIDATE_ROSTER = 'cers-candidate-roster';
export const RECORD_KIND_REPORT_INDEX = 'cers-report-index';
export const RECORD_KIND_REPORT_SCHEDULE = 'cers-report-schedule';

/**
 * One sweep target: a campaign type, optionally one office, in one county.
 *
 * Declared rather than derived so an operator can read off exactly which slice
 * of a statewide system this project looks at, and so widening it is a config
 * change with a reason attached rather than an unbounded crawl.
 */
export interface CersSweepTarget {
  /** Short slug used in ref titles and in `metadata.target`. */
  key: string;
  /** Human-readable, e.g. 'Gallatin County Commissioner'. */
  label: string;
  campaignType: string;
  countyCode: string;
  /** Omitted to sweep every office of that campaign type in the county. */
  officeCode?: string;
}

export const DEFAULT_SWEEP_TARGETS: readonly CersSweepTarget[] = Object.freeze([
  {
    key: 'gallatin-county-commissioner',
    label: 'Gallatin County Commissioner',
    campaignType: CAMPAIGN_TYPE_COUNTY,
    countyCode: GALLATIN_COUNTY_CODE,
    officeCode: COUNTY_COMMISSIONER_OFFICE_CODE,
  },
  {
    key: 'gallatin-city-offices',
    label: 'City offices, Gallatin County',
    campaignType: CAMPAIGN_TYPE_CITY,
    countyCode: GALLATIN_COUNTY_CODE,
  },
]);

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

/**
 * The DataTables envelope every list endpoint returns.
 *
 * `iTotalRecords` is the size of the result set the session holds, which is what
 * makes pagination checkable rather than "keep going until a page is short".
 */
export interface DataTablesEnvelope<T> {
  aaData: T[];
  iTotalRecords: number;
  iTotalDisplayRecords: number;
}

/**
 * A candidate row from `listCandidateResults`.
 *
 * **`resCountyDescr` is the candidate's county of residence, not the
 * jurisdiction of the office.** CERS has no city or municipality field at all —
 * the 275-entry office select contains no city names — so "is this a Bozeman
 * candidate?" could only be answered from the residence address, which was a
 * heuristic rather than a key: the spike found candidacies from five different
 * Gallatin towns inside one result set, including one against a `Councilman`
 * seat in another town. This adapter never asserts a jurisdiction CERS did not
 * state, and it no longer reads the address that heuristic was built on.
 *
 * **There is deliberately no `candidateAddress` here.** CERS serves one, and
 * this type used to parse it and put it in `DocumentRef.metadata`, from where
 * it round-tripped into `ingestion_jobs.target.metadata` — so the sweep was
 * writing a candidate's residence address into this project's database on every
 * run. That is exactly what the operator's directive forbids, public record or
 * not. A county is the jurisdiction a candidacy is filed in and stays; a street
 * address is where a person sleeps and does not.
 */
export interface CersCandidate {
  candidateId: number;
  entId: number;
  candidateName: string;
  officeCode: string | null;
  officeTitle: string | null;
  candidateTypeCode: string | null;
  candidateTypeDescr: string | null;
  resCountyCode: string | null;
  resCountyDescr: string | null;
  partyCode: string | null;
  partyDescr: string | null;
  electionYear: string | null;
  candidateStatusDescr: string | null;
  filingStatusDescr: string | null;
}

/** A filed report row from `listFinanceReports`. */
export interface CersReport {
  reportId: number;
  formTypeCode: string | null;
  formTypeDescr: string | null;
  reportTypeDescr: string | null;
  filingTypeDescr: string | null;
  statusDescr: string | null;
  fromDateStr: string | null;
  toDateStr: string | null;
}

/**
 * One line item of a report schedule, from `financeRepDetailList`.
 *
 * The same envelope carries contributions and expenditures; which one it is
 * comes from the `listName` that was asked for, never from the row. A row's own
 * `lineItemCompositeDescr` is a label CERS chose for display and is not a
 * closed domain.
 *
 * ## The response carries more than this, on purpose
 *
 * CERS returns `entityAddress`, `occupationDescr` and `employerDescr` on every
 * contribution row, and this interface deliberately does not have them. They
 * describe the donor as a person rather than the contribution as a public act,
 * and the operator's instruction is that we do not ingest PII — so the field is
 * absent from the type, which makes it absent from every caller. Dropping them
 * at the parser rather than at the writer is what makes that true: a value this
 * never produces cannot be stored by a writer that later grows a column for it.
 * See migration 043.
 *
 * `entityName`, `datePaid` and the three amounts stay. They are the disclosure,
 * and `vote_donor_conflict` has nothing to say without them.
 */
export interface CersLineItem {
  entityName: string | null;
  amountTypeDescr: string | null;
  datePaid: number | null;
  cashAmt: number | null;
  inKindAmt: number | null;
  totalAmt: number | null;
  purposeDescr: string | null;
  descriptionDescr: string | null;
  lineItemCompositeDescr: string | null;
}

// ---------------------------------------------------------------------------
// Narrowing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function requiredNumber(value: unknown, field: string): number {
  const parsed = optionalNumber(value);
  if (parsed === null) throw new TypeError(`CERS ${field}: expected a number`);
  return parsed;
}

/**
 * Decodes a CERS response as JSON, or fails loudly naming what came back.
 *
 * There is deliberately no HTML fallback. If this ever throws with an HTML body,
 * the answer is to read what the body says and stop — not to teach the adapter
 * to parse it. See the hard-line note at the top of this file.
 */
/**
 * True when CERS answered 200 with nothing at all.
 *
 * Observed on the first real sweep: `financeRepDetailList` for
 * `expendIndependent` on a candidate C-5 returns a **zero-byte** body rather
 * than `[]`. There is genuinely nothing to parse, and failing the job made the
 * whole run `partial` forever over a schedule that simply does not apply.
 *
 * It is narrower than "falsy body" on purpose: an empty body is nothing to
 * parse, whereas a short *non-empty* body that is not JSON is a signal — a WAF
 * interstitial arrives looking exactly like that — and must still throw.
 */
export function isEmptyBody(bytes: Uint8Array): boolean {
  return new TextDecoder('utf-8').decode(bytes).trim() === '';
}

export function expectJson(bytes: Uint8Array, url: string): unknown {
  const text = new TextDecoder('utf-8').decode(bytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const opening = text.slice(0, 200).replace(/\s+/g, ' ').trim();
    throw new Error(
      `CERS returned a non-JSON body for ${url}. This adapter does not parse an ` +
        `unexpected body, because doing so is how a block becomes a workaround. ` +
        `First bytes: ${opening}`,
    );
  }
}

/** Narrows a DataTables envelope, mapping its rows with `mapRow`. */
export function parseEnvelope<T>(
  payload: unknown,
  url: string,
  mapRow: (row: Record<string, unknown>) => T,
): DataTablesEnvelope<T> {
  if (!isRecord(payload) || !Array.isArray(payload.aaData)) {
    throw new TypeError(`CERS ${url}: expected a DataTables envelope with aaData`);
  }
  const rows: T[] = [];
  for (const raw of payload.aaData) {
    if (!isRecord(raw)) continue;
    rows.push(mapRow(raw));
  }
  return {
    aaData: rows,
    iTotalRecords: optionalNumber(payload.iTotalRecords) ?? rows.length,
    iTotalDisplayRecords: optionalNumber(payload.iTotalDisplayRecords) ?? rows.length,
  };
}

export function toCandidate(row: Record<string, unknown>): CersCandidate {
  return {
    candidateId: requiredNumber(row.candidateId, 'candidateId'),
    entId: requiredNumber(row.entId, 'entId'),
    candidateName: optionalString(row.candidateName) ?? '',
    // `row.candidateAddress` is present in the response and is deliberately not
    // read. Dropping PII at the parser is the only place it stays dropped.
    officeCode: optionalString(row.officeCode),
    officeTitle: optionalString(row.officeTitle),
    candidateTypeCode: optionalString(row.candidateTypeCode),
    candidateTypeDescr: optionalString(row.candidateTypeDescr),
    resCountyCode: optionalString(row.resCountyCode),
    resCountyDescr: optionalString(row.resCountyDescr),
    partyCode: optionalString(row.partyCode),
    partyDescr: optionalString(row.partyDescr),
    electionYear: optionalString(row.electionYear),
    candidateStatusDescr: optionalString(row.candidateStatusDescr),
    filingStatusDescr: optionalString(row.filingStatusDescr),
  };
}

export function toReport(row: Record<string, unknown>): CersReport {
  return {
    reportId: requiredNumber(row.reportId, 'reportId'),
    formTypeCode: optionalString(row.formTypeCode),
    formTypeDescr: optionalString(row.formTypeDescr),
    reportTypeDescr: optionalString(row.reportTypeDescr),
    filingTypeDescr: optionalString(row.filingTypeDescr),
    statusDescr: optionalString(row.statusDescr),
    fromDateStr: optionalString(row.fromDateStr),
    toDateStr: optionalString(row.toDateStr),
  };
}

export function toLineItem(row: Record<string, unknown>): CersLineItem {
  return {
    entityName: optionalString(row.entityName),
    // row.entityAddress, row.occupationDescr and row.employerDescr are present
    // in the response and are not read. See CersLineItem's header.
    amountTypeDescr: optionalString(row.amountTypeDescr),
    datePaid: optionalNumber(row.datePaid),
    cashAmt: optionalNumber(row.cashAmt),
    inKindAmt: optionalNumber(row.inKindAmt),
    totalAmt: optionalNumber(row.totalAmt),
    purposeDescr: optionalString(row.purposeDescr),
    descriptionDescr: optionalString(row.descriptionDescr),
    lineItemCompositeDescr: optionalString(row.lineItemCompositeDescr),
  };
}

/** Narrows the array `financeRepDetailList` returns (it has no envelope). */
export function parseLineItems(payload: unknown, url: string): CersLineItem[] {
  if (!Array.isArray(payload)) {
    throw new TypeError(`CERS ${url}: expected an array of line items`);
  }
  return payload.filter(isRecord).map(toLineItem);
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

/**
 * DataTables 1.9 query parameters.
 *
 * The endpoints honour `iDisplayStart` and `iDisplayLength`, so paging is a
 * property of the protocol rather than a guess. `sEcho` is echoed back and is
 * ignored here; it exists to let a browser discard a stale response.
 */
export function dataTablesQuery(start: number, length: number, columns: number): string {
  const params = new URLSearchParams({
    sEcho: '1',
    iDisplayStart: String(start),
    iDisplayLength: String(length),
    iColumns: String(columns),
    iSortingCols: '1',
    iSortCol_0: '0',
    sSortDir_0: 'asc',
    sSearch: '',
  });
  for (let index = 0; index < columns; index += 1) {
    params.set(`mDataProp_${index}`, String(index));
    params.set(`bSortable_${index}`, 'true');
    params.set(`bSearchable_${index}`, 'true');
    params.set(`sSearch_${index}`, '');
  }
  return params.toString();
}

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

/**
 * The identity a stored CERS record is filed under.
 *
 * Endpoint plus the chain parameters, rendered as a query string. Stable across
 * sweeps, unique per record, and readable by a person looking at the console.
 * **Not dereferenceable**: the live request is a POST whose criteria live in a
 * session. See the file header.
 */
export function recordUrl(endpoint: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params);
  query.sort();
  return `${BASE_URL}/${endpoint}?${query.toString()}`;
}

// ---------------------------------------------------------------------------
// Session position
// ---------------------------------------------------------------------------

/**
 * Where a CERS session currently is.
 *
 * This is the source's actual protocol written down. A CERS response is not a
 * function of its request: `financeRepDetailList` with `listName=individual`
 * returns a different schedule for every report, and which one depends entirely
 * on which `retrieveReport` came before it in the same session.
 *
 * The adapter uses it to avoid replaying a leg it is already standing on, and
 * the fixture harness uses it to key recorded exchanges. Both need the same
 * answer: a fixture keyed on the request alone would serve one report's
 * contributions for every report, and the tests would pass.
 */
export interface CersSessionPosition {
  /** The candidate search last run, as its form body. */
  search: string;
  candidateId: string;
  reportId: string;
}

export const EMPTY_SESSION: CersSessionPosition = Object.freeze({
  search: '',
  candidateId: '',
  reportId: '',
});

function bodyField(body: string | undefined, field: string): string {
  return new URLSearchParams(body ?? '').get(field) ?? '';
}

/** The position after `request` has been issued from `position`. */
export function advanceSession(
  position: CersSessionPosition,
  request: HttpRequest,
): CersSessionPosition {
  const path = new URL(request.url).pathname;
  if (path.endsWith('/searchResults/searchCandidates')) {
    // A search overwrites the session's search slot and invalidates any
    // candidate or report selected under the previous one.
    return { search: request.body ?? '', candidateId: '', reportId: '' };
  }
  if (path.endsWith('/publicReportList/retrieveCampaignReports')) {
    return { ...position, candidateId: bodyField(request.body, 'candidateId'), reportId: '' };
  }
  if (path.endsWith('/viewFinanceReport/retrieveReport')) {
    return {
      ...position,
      candidateId: bodyField(request.body, 'candidateId') || position.candidateId,
      reportId: bodyField(request.body, 'reportId'),
    };
  }
  return position;
}

/**
 * A stable identity for one exchange: the request, plus **only** the session
 * state that determines its response.
 *
 * The "only" is load-bearing and was learned by getting it wrong. Keying on the
 * whole position made the tape depend on the order the recorder happened to
 * walk in: fetching the same roster twice, or opening candidate B's report
 * before candidate A's, produced keys that had never been recorded even though
 * the responses were identical. The fix is to say per endpoint what the server
 * actually reads:
 *
 *  - `listCandidateResults`  — the search last run
 *  - `publicReportList`, `listFinanceReports` — the candidate selected
 *  - `financeRepDetailList`  — the candidate and the report opened
 *  - everything else (the POSTs that *set* that state, the session page) —
 *    nothing but the request itself
 *
 * DataTables paging parameters are dropped, because `sEcho` is a browser
 * cache-buster and would make every recording unique, and `;jsessionid=…` is
 * dropped because it is per-session by definition.
 */
export function cersExchangeKey(
  position: CersSessionPosition,
  request: HttpRequest,
): string {
  const url = new URL(request.url);
  const page = url.searchParams.get('iDisplayStart') ?? '';
  const path = url.pathname.replace(/;jsessionid=[^/;?]*/gi, '');

  let context = '';
  if (path.endsWith('/searchResults/listCandidateResults')) {
    context = position.search;
  } else if (
    path.endsWith('/publicReportList') ||
    path.endsWith('/publicReportList/listFinanceReports')
  ) {
    context = position.candidateId;
  } else if (path.endsWith('/viewFinanceReport/financeRepDetailList')) {
    context = `${position.candidateId}/${position.reportId}`;
  }

  return [context, request.method, path, page, request.body ?? ''].join('|');
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface CersAdapterOptions {
  transport?: HttpTransport;
  /** Overrides {@link DEFAULT_SWEEP_TARGETS}. */
  targets?: readonly CersSweepTarget[];
  /** Which report schedules to read. Defaults to all four. */
  schedules?: readonly CersSchedule[];
  /**
   * Hard cap on candidates walked per sweep target. A statewide filing system
   * is large and a sweep that grows without bound is a sweep nobody authorised.
   */
  maxCandidatesPerTarget?: number;
  /** Cap on filed reports walked per candidate, newest first. */
  maxReportsPerCandidate?: number;
  /** Rows requested per list page. */
  pageSize?: number;
  now?: () => Date;
}

/**
 * The caps, and why they are this small.
 *
 * At one request every two seconds a sweep's duration is arithmetic, not a
 * guess: a report costs five requests (open it, then one per schedule), a
 * candidate costs two plus its reports, and a target costs two plus its
 * candidates. Five candidates × three reports × four schedules across two
 * targets is roughly 300 requests, about ten minutes — which fits inside the
 * scheduler's sweep timeout. Twenty-five × twelve, the first draft, is over
 * three thousand requests and close to two hours: it would have timed out every
 * night, left its jobs queued, and looked like a broken scraper rather than an
 * unreasonable setting.
 *
 * **Known limitation.** The cap slices the roster in the order CERS returns it,
 * which is alphabetical, so a target with more candidates than the cap always
 * sweeps the same ones and never reaches the rest. That is a real gap and it is
 * recorded here rather than hidden behind a comfortable default; closing it
 * needs a cursor in `ingestion_sources.config`, which is separate work.
 */
const DEFAULT_MAX_CANDIDATES = 5;
const DEFAULT_MAX_REPORTS = 3;
const DEFAULT_PAGE_SIZE = 100;

/**
 * Five seconds between requests, one at a time. Never concurrent.
 *
 * Slower than every other adapter here, and deliberately. `cers-ext.mt.gov`
 * publishes **no `robots.txt` at all** — see `docs/exploration/mt-cers-spike.md`
 * — so there is no stated rate to honour and no `Crawl-delay` to point at. Two
 * seconds was a number this project chose for itself against a host that never
 * agreed to it.
 *
 * Where a source has published a rate we follow it exactly; where it has
 * published nothing we err slower rather than assuming the general default was
 * meant for us. A state agency's filing system is also the one host here whose
 * unavailability would matter to people with nothing to do with this project.
 *
 * Raised from 2000ms on 2026-08-16, at the operator's instruction to be gentle
 * with the state site, before it swept for the first time.
 */
const MIN_DELAY_MS = 5000;

/** Redirect hops followed before giving up. CERS uses one; a loop is a defect. */
const MAX_REDIRECTS = 5;

/** Upper bound on roster pages walked, so a bad `iTotalRecords` cannot spin. */
const MAX_ROSTER_PAGES = 20;

const NOTES =
  'Montana campaign finance (CERS, cers-ext.mt.gov/CampaignTracker). The host publishes no ' +
  'robots.txt at all — /robots.txt is a Tomcat 404, not a Disallow — and there is no login, no ' +
  'CAPTCHA and no user-agent discrimination, so this source needs no access exception and none is ' +
  'claimed. There is no bulk download, CSV or documented API: records are read entity by entity ' +
  'from a session-scoped JSON API, scoped to Gallatin County by county code and campaign type. ' +
  'Registered disabled like every source. See docs/exploration/mt-cers-spike.md.';

export class CersAdapter implements SourceAdapter {
  readonly key = 'mt-cers';

  private readonly transport: HttpTransport;
  private readonly targets: readonly CersSweepTarget[];
  private readonly schedules: readonly CersSchedule[];
  private readonly maxCandidates: number;
  private readonly maxReports: number;
  private readonly pageSize: number;
  private readonly now: () => Date;

  /**
   * The cookie jar.
   *
   * An anonymous session, minted on demand by asking for the search page. It
   * carries no credential and identifies nobody; it is how a 2014-era Spring
   * application remembers which search you ran, and it is the reason this
   * adapter cannot be a sequence of independent GETs.
   */
  private cookies = new Map<string, string>();

  /**
   * Where the session currently is, so a chain is not replayed needlessly.
   *
   * Consecutive schedules of the same report differ only in the final request.
   * Tracking the position turns four requests per schedule into one, which is
   * politeness expressed as arithmetic rather than as an intention. It is
   * maintained by {@link advanceSession}, the same function the fixture harness
   * uses, so the adapter's idea of the protocol and the tests' cannot drift.
   */
  private position: CersSessionPosition = EMPTY_SESSION;

  constructor(options: CersAdapterOptions = {}) {
    this.transport =
      options.transport ??
      createPoliteTransport({ minDelayMs: MIN_DELAY_MS, userAgent: COMMISSIONWATCH_USER_AGENT });
    this.targets = options.targets ?? DEFAULT_SWEEP_TARGETS;
    this.schedules = options.schedules ?? ALL_SCHEDULES;
    this.maxCandidates = options.maxCandidatesPerTarget ?? DEFAULT_MAX_CANDIDATES;
    this.maxReports = options.maxReportsPerCandidate ?? DEFAULT_MAX_REPORTS;
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.now = options.now ?? (() => new Date());
  }

  describeSource(): SourceDescriptor {
    return {
      key: this.key,
      jurisdiction: {
        name: 'State of Montana',
        state: 'MT',
        // Neither a city nor a county. Migration 037 added `'state'` to the
        // enum for exactly this row and typing it as either of the others to
        // avoid the enum change would put a false claim in the column.
        type: 'state',
        websiteUrl: BASE_URL,
      },
      // Deliberately empty. CERS publishes no meetings and this adapter
      // discovers none, so declaring a body would create a `commissions` row
      // for a body that does not sit. See `discoverDocuments`.
      bodies: [],
      baseUrls: [BASE_URL],
      politeness: {
        minDelayMs: MIN_DELAY_MS,
        maxConcurrency: 1,
        userAgent: COMMISSIONWATCH_USER_AGENT,
        // There is no robots.txt to respect. Left true so that if one ever
        // appears it is honoured by default rather than by a later decision.
        respectRobotsTxt: true,
        maxRetries: 2,
      },
      supportsLiveFetch: true,
      notes: NOTES,
    };
  }

  /** CERS publishes no meetings. Not an omission — there are none. */
  discoverMeetings(): Promise<MeetingRef[]> {
    return Promise.resolve([]);
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /**
   * Walks candidate rosters and their filed reports, emitting one ref per
   * stored record.
   *
   * Three kinds come out, and all three are stored, because provenance is the
   * product and the roster is as much a fact about the record as the schedule
   * is: the roster JSON, each candidate's report index, and each report
   * schedule.
   *
   * `since` filters on election year, which is the only date CERS attaches to a
   * candidacy that means anything for coverage. It is deliberately generous —
   * a report filed in 2026 for the 2026 cycle and one filed in 2027 closing it
   * out are both that cycle's record.
   */
  async discoverDocuments(since: Date): Promise<DocumentRef[]> {
    const minimumYear = since.getUTCFullYear();
    const refs: DocumentRef[] = [];

    for (const target of this.targets) {
      // Every page, not just the first. The first real sweep wrote 142 filers
      // against 384 that exist, because a single 100-row page was read and the
      // shortfall was invisible — `iTotalRecords` was right there saying so.
      const roster: CersCandidate[] = [];
      for (let start = 0; start < MAX_ROSTER_PAGES * this.pageSize; start += this.pageSize) {
        const page = await this.loadRoster(target, start);
        // The first page is always recorded, even when empty: "this target has
        // no candidates" is a fact about the record and needs an artifact
        // behind it like any other.
        if (start === 0 || page.aaData.length > 0) {
          refs.push(this.rosterRef(target, page.iTotalRecords, start));
        }
        roster.push(...page.aaData);
        // A short page ends the walk as well as the count does, so a source
        // that misreports its own total cannot make this spin.
        if (page.aaData.length === 0 || roster.length >= page.iTotalRecords) break;
      }

      const candidates = roster
        .filter((candidate) => this.isWithin(candidate, minimumYear))
        .slice(0, this.maxCandidates);

      for (const candidate of candidates) {
        const reports = await this.loadReports(candidate.candidateId);
        refs.push(this.reportIndexRef(target, candidate, reports.iTotalRecords));

        for (const report of reports.aaData.slice(0, this.maxReports)) {
          for (const schedule of this.schedules) {
            refs.push(this.scheduleRef(target, candidate, report, schedule));
          }
        }
      }
    }

    return refs;
  }

  private isWithin(candidate: CersCandidate, minimumYear: number): boolean {
    const year = Number(candidate.electionYear);
    // A candidacy with no election year is kept rather than dropped: an
    // unparseable year is a gap in their data, and silently discarding the row
    // would turn their gap into our omission.
    if (!Number.isFinite(year)) return true;
    return year >= minimumYear;
  }

  private rosterRef(target: CersSweepTarget, total: number, start: number): DocumentRef {
    const params = {
      campaignType: target.campaignType,
      countyCode: target.countyCode,
      ...(target.officeCode === undefined ? {} : { officeCode: target.officeCode }),
      // Part of the identity, not decoration: two pages of the same roster are
      // two different documents and must not share a URL.
      start: String(start),
      length: String(this.pageSize),
    };
    const page = Math.floor(start / this.pageSize) + 1;
    return {
      sourceKey: this.key,
      kind: 'other',
      title: `CERS candidate roster — ${target.label}, page ${page} of ${total} records`,
      url: recordUrl('public/searchResults/listCandidateResults', params),
      expectedContentType: 'application/json',
      metadata: {
        recordKind: RECORD_KIND_CANDIDATE_ROSTER,
        target: target.key,
        targetLabel: target.label,
        ...params,
      },
    };
  }

  private reportIndexRef(
    target: CersSweepTarget,
    candidate: CersCandidate,
    total: number,
  ): DocumentRef {
    return {
      sourceKey: this.key,
      kind: 'other',
      title: `CERS filed reports — ${candidate.candidateName} (${total} reports)`,
      url: recordUrl('public/publicReportList/listFinanceReports', {
        candidateId: String(candidate.candidateId),
      }),
      expectedContentType: 'application/json',
      metadata: {
        recordKind: RECORD_KIND_REPORT_INDEX,
        target: target.key,
        candidateId: String(candidate.candidateId),
        entId: String(candidate.entId),
        candidateName: candidate.candidateName,
      },
    };
  }

  private scheduleRef(
    target: CersSweepTarget,
    candidate: CersCandidate,
    report: CersReport,
    schedule: CersSchedule,
  ): DocumentRef {
    const period =
      report.fromDateStr && report.toDateStr
        ? ` ${report.fromDateStr}–${report.toDateStr}`
        : '';
    return {
      sourceKey: this.key,
      kind: 'other',
      title:
        `CERS ${report.formTypeCode ?? 'report'} ${schedule} — ` +
        `${candidate.candidateName}${period}`,
      url: recordUrl('public/viewFinanceReport/financeRepDetailList', {
        candidateId: String(candidate.candidateId),
        reportId: String(report.reportId),
        listName: schedule,
      }),
      expectedContentType: 'application/json',
      metadata: {
        recordKind: RECORD_KIND_REPORT_SCHEDULE,
        target: target.key,
        schedule,
        candidateId: String(candidate.candidateId),
        entId: String(candidate.entId),
        candidateName: candidate.candidateName,
        reportId: String(report.reportId),
        ...(candidate.electionYear === null ? {} : { electionYear: candidate.electionYear }),
        ...(candidate.officeTitle === null ? {} : { officeTitle: candidate.officeTitle }),
        ...(candidate.candidateTypeCode === null
          ? {}
          : { campaignType: candidate.candidateTypeCode }),
        ...(candidate.partyDescr === null ? {} : { party: candidate.partyDescr }),
        ...(report.formTypeCode === null ? {} : { formType: report.formTypeCode }),
        ...(report.statusDescr === null ? {} : { reportStatus: report.statusDescr }),
        ...(report.fromDateStr === null ? {} : { periodFrom: report.fromDateStr }),
        ...(report.toDateStr === null ? {} : { periodTo: report.toDateStr }),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Fetch
  // -------------------------------------------------------------------------

  /**
   * Replays the chain a ref describes and content-addresses what comes back.
   *
   * The session position is reset for a roster because a roster's criteria
   * overwrite whatever search was last run — the same session slot holds both.
   */
  async fetchDocument(ref: DocumentRef): Promise<FetchedArtifact> {
    if (!ref.url.startsWith(`${BASE_URL}/`)) {
      throw new OffSourceUrlError(ref.url, [BASE_URL]);
    }
    const metadata = ref.metadata ?? {};
    const kind = metadata.recordKind;

    let bytes: Uint8Array;
    switch (kind) {
      case RECORD_KIND_CANDIDATE_ROSTER:
        bytes = await this.fetchRosterBytes(metadata);
        break;
      case RECORD_KIND_REPORT_INDEX:
        bytes = await this.fetchReportIndexBytes(metadata);
        break;
      case RECORD_KIND_REPORT_SCHEDULE:
        bytes = await this.fetchScheduleBytes(metadata);
        break;
      default:
        throw new TypeError(
          `mt-cers cannot fetch ref '${ref.url}': unknown metadata.recordKind ${String(kind)}`,
        );
    }

    return {
      bytes,
      contentType: 'application/json',
      // The identity, not the transport's final URL: the POST's URL carries
      // none of the parameters, so every schedule of every candidate would
      // otherwise record the same source_url and the provenance would be a
      // pointer to an endpoint rather than to a record.
      sourceUrl: ref.url,
      sha256: sha256Hex(bytes),
      byteSize: bytes.length,
      fetchedAt: this.now().toISOString(),
      ref,
    };
  }

  private requireMetadata(metadata: Record<string, string>, field: string): string {
    const value = metadata[field];
    if (typeof value !== 'string' || value === '') {
      throw new TypeError(`mt-cers ref metadata is missing '${field}'`);
    }
    return value;
  }

  private async fetchRosterBytes(metadata: Record<string, string>): Promise<Uint8Array> {
    await this.runCandidateSearch({
      campaignType: this.requireMetadata(metadata, 'campaignType'),
      countyCode: this.requireMetadata(metadata, 'countyCode'),
      ...(metadata.officeCode === undefined ? {} : { officeCode: metadata.officeCode }),
      key: metadata.target ?? 'target',
      label: metadata.targetLabel ?? 'target',
    });
    const start = Number(metadata.start ?? '0');
    const length = Number(metadata.length ?? String(this.pageSize));
    return this.getBytes(
      `${BASE_URL}/public/searchResults/listCandidateResults?${dataTablesQuery(
        Number.isFinite(start) ? start : 0,
        Number.isFinite(length) && length > 0 ? length : this.pageSize,
        9,
      )}`,
    );
  }

  private async fetchReportIndexBytes(metadata: Record<string, string>): Promise<Uint8Array> {
    await this.selectCandidate(this.requireMetadata(metadata, 'candidateId'));
    return this.getBytes(
      `${BASE_URL}/public/publicReportList/listFinanceReports?${dataTablesQuery(0, this.pageSize, 6)}`,
    );
  }

  private async fetchScheduleBytes(metadata: Record<string, string>): Promise<Uint8Array> {
    const candidateId = this.requireMetadata(metadata, 'candidateId');
    const reportId = this.requireMetadata(metadata, 'reportId');
    const schedule = this.requireMetadata(metadata, 'schedule');
    await this.openReport(candidateId, reportId);
    const response = await this.request({
      url: `${BASE_URL}/public/viewFinanceReport/financeRepDetailList`,
      method: 'POST',
      body: formBody({ listName: schedule }),
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    return response.bytes;
  }

  // -------------------------------------------------------------------------
  // The chain
  // -------------------------------------------------------------------------

  /** Mints an anonymous session by asking for the public search page. */
  private async establishSession(): Promise<void> {
    if (this.cookies.size > 0) return;
    await this.request({
      url: `${BASE_URL}/public/search/candidateSearch`,
      method: 'GET',
    });
  }

  private async runCandidateSearch(target: CersSweepTarget): Promise<void> {
    await this.establishSession();
    await this.request({
      url: `${BASE_URL}/public/searchResults/searchCandidates`,
      method: 'POST',
      body: formBody({
        lastName: '',
        firstName: '',
        middleInitial: '',
        electionYear: '',
        candidateTypeCode: target.campaignType,
        officeCode: target.officeCode ?? '',
        countyCode: target.countyCode,
        partyCode: '',
      }),
    });
  }

  private async selectCandidate(candidateId: string): Promise<void> {
    if (this.position.candidateId === candidateId) return;
    await this.establishSession();
    await this.request({
      url: `${BASE_URL}/public/publicReportList/retrieveCampaignReports`,
      method: 'POST',
      body: formBody({
        searchType: 'Contributors',
        financialSearchType: 'CANDIDATE',
        candidateId,
        searchPage: 'public',
        financialSearchResultsHeaderText: '',
      }),
    });
  }

  private async openReport(candidateId: string, reportId: string): Promise<void> {
    await this.selectCandidate(candidateId);
    if (this.position.reportId === reportId) return;
    await this.request({
      url: `${BASE_URL}/public/viewFinanceReport/retrieveReport`,
      method: 'POST',
      body: formBody({ reportId, searchPage: 'public', candidateId }),
    });
  }

  private async loadRoster(
    target: CersSweepTarget,
    start: number,
  ): Promise<DataTablesEnvelope<CersCandidate>> {
    await this.runCandidateSearch(target);
    const url = `${BASE_URL}/public/searchResults/listCandidateResults?${dataTablesQuery(start, this.pageSize, 9)}`;
    return parseEnvelope(expectJson(await this.getBytes(url), url), url, toCandidate);
  }

  private async loadReports(candidateId: number): Promise<DataTablesEnvelope<CersReport>> {
    await this.selectCandidate(String(candidateId));
    const url = `${BASE_URL}/public/publicReportList/listFinanceReports?${dataTablesQuery(0, this.pageSize, 6)}`;
    return parseEnvelope(expectJson(await this.getBytes(url), url), url, toReport);
  }

  private async getBytes(url: string): Promise<Uint8Array> {
    const response = await this.request({
      url,
      method: 'GET',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    return response.bytes;
  }

  /**
   * One request, with the session cookies attached and any new ones kept.
   *
   * The transport supplies the honest user agent and the politeness delay, so
   * there is no rate limiting here to get out of step with the declared policy.
   */
  private async request(request: HttpRequest): Promise<HttpResponse> {
    let current: HttpRequest = { ...request, redirect: 'manual' };

    // Redirects are followed here rather than by the transport, because CERS
    // mints `JSESSIONID` on a **302** and `fetch` exposes only the final
    // response's headers. Letting the transport follow made every search run in
    // a fresh session and answer `iTotalRecords: 0` — HTTP 200, no error, and
    // the wrong answer. A silent zero from a transparency source is the worst
    // failure mode available, so the hop is walked one at a time and the
    // cookies are taken from each.
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const url = new URL(current.url);
      if (url.origin !== ORIGIN) {
        throw new OffSourceUrlError(current.url, [BASE_URL]);
      }
      const headers: Record<string, string> = { ...(current.headers ?? {}) };
      if (this.cookies.size > 0) {
        headers.Cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
      }

      const response = await this.transport({ ...current, headers });
      this.absorbCookies(response);
      // Advanced on the request that was issued, not on the one that came back
      // — a 302 is still a leg the server acted on.
      this.position = advanceSession(this.position, current);

      if (response.status < 300 || response.status >= 400) {
        if (response.status < 200 || response.status >= 300) {
          throw new HttpStatusError(current.url, response.status);
        }
        return response;
      }

      const location = response.headers.location;
      if (location === undefined || location === '') {
        throw new HttpStatusError(current.url, response.status);
      }
      // 303, and 302 in practice, turn a POST into a GET; the body does not
      // survive the hop and carrying it would re-submit the form.
      current = { url: new URL(location, current.url).toString(), method: 'GET', redirect: 'manual' };
    }

    throw new Error(`mt-cers: more than ${MAX_REDIRECTS} redirects fetching ${request.url}`);
  }

  /**
   * Keeps whatever the server set, from every `Set-Cookie` on the response.
   *
   * `HttpResponse.setCookies` rather than `headers['set-cookie']`, because the
   * flat header map keeps only the last cookie of a response that sets several
   * — and CERS sets three at once, `JSESSIONID` first.
   */
  private absorbCookies(response: HttpResponse): void {
    for (const raw of response.setCookies ?? []) {
      const pair = raw.split(';', 1)[0] ?? '';
      const equals = pair.indexOf('=');
      if (equals <= 0) continue;
      const name = pair.slice(0, equals).trim();
      const value = pair.slice(equals + 1).trim();
      if (name !== '' && value !== '') this.cookies.set(name, value);
    }
  }
}

export function createMtCersAdapter(options: CersAdapterOptions = {}): CersAdapter {
  return new CersAdapter(options);
}
