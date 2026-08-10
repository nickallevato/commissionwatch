/**
 * Records the CERS fixture tape. Run by hand, never in CI:
 *
 *   cd backend && npx tsx test/fixtures/mt-cers/record.ts
 *
 * It drives the **real adapter** against the real host through a transport that
 * writes every exchange to disk, so the tape is by construction exactly what
 * the adapter asks for. A hand-written fixture is a fixture that can disagree
 * with the source and still go green.
 *
 * It lives under `test/` rather than `src/scripts/` because it is test
 * scaffolding and `backend/Dockerfile` ships `dist/` — a recorder in the
 * production image is a network client nobody meant to deploy.
 *
 * Politeness is the adapter's own: one request at a time, 2.5 seconds apart,
 * the honest project user agent. Nothing here overrides it. Roughly 30 requests
 * against a public state system, once.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMMISSIONWATCH_USER_AGENT,
  createPoliteTransport,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from '../../../src/services/ingestion/adapters/http';
import {
  CAMPAIGN_TYPE_COUNTY,
  COUNTY_COMMISSIONER_OFFICE_CODE,
  EMPTY_SESSION,
  GALLATIN_COUNTY_CODE,
  advanceSession,
  cersExchangeKey,
  createMtCersAdapter,
  type CersSessionPosition,
} from '../../../src/services/ingestion/adapters/mt-cers';
import type { TapeExchange } from '../../helpers/cers-tape';

const OUT_DIR = __dirname;

/**
 * Fields CERS returns on every contribution row that must never land on disk.
 *
 * They describe the donor as a person — a street address, an occupation, an
 * employer — rather than the contribution as a public act. The operator's
 * instruction is that we do not ingest PII, and a fixture committed to a public
 * repository is the most durable form of ingesting it: it outlives the database
 * it was swept into. The adapter does not read these fields (see `CersLineItem`)
 * and migration 043 removed the columns, so scrubbing costs the tests nothing.
 */
const PII_FIELDS = ['entityAddress', 'occupationDescr', 'employerDescr'] as const;

/**
 * Replaces donor PII in a `financeRepDetailList` body with synthetic values.
 *
 * **This runs on the way to disk, not on the way to the adapter.** The adapter
 * under recording sees exactly what CERS sent, so the tape still proves the
 * adapter handles the real protocol; only the bytes that get committed are
 * changed.
 *
 * Structure, field names, key order, types and populated-ness are all
 * preserved — an empty string stays an empty string, so a row that filed no
 * occupation still exercises the "no occupation" path. A body that is not the
 * expected array of objects is returned untouched rather than reshaped, because
 * a recorder that silently rewrites an unexpected response is a recorder that
 * hides a protocol change.
 */
function scrubLineItemPii(bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder('utf-8').decode(bytes);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return bytes;
  }
  if (!Array.isArray(payload)) return bytes;

  let index = 0;
  for (const row of payload) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const seq = 100 + index * 10;
    for (const field of PII_FIELDS) {
      const value = record[field];
      if (typeof value !== 'string' || value === '') continue;
      record[field] =
        field === 'entityAddress'
          ? `${seq} Example Ave, Fixtureville, MT 00000`
          : `Example ${field === 'occupationDescr' ? 'Occupation' : 'Employer'} ${seq}`;
    }
    index += 1;
  }
  return new TextEncoder().encode(JSON.stringify(payload));
}

/* ------------------------------------------------------------------------- */
/* Contact PII, on every response rather than on one endpoint                 */
/* ------------------------------------------------------------------------- */

/**
 * `scrubLineItemPii` is field-driven and endpoint-driven, and both of those are
 * how the first pass missed things.
 *
 * CERS puts a person's contact details in more places than the schedule rows:
 * the roster's `personDTO` carries candidates' mailing and home addresses,
 * personal email addresses and home, work and mobile telephone numbers;
 * `listFinanceReports` embeds the same `personDTO` inside `candidateDTO`; the
 * rendered C-5 HTML prints the candidate's address, email and telephone number
 * and the *campaign treasurer's* home address; and free text gets typed into
 * fields that are not contact fields at all — an email address was found in a
 * candidacy's `comments` and another in an expenditure's `purposeDescr`.
 *
 * So this scrub is driven by **shape** and runs over every recorded body,
 * whatever the endpoint and whatever the field is called. A field-name list can
 * only ever catch the fields somebody already knew about.
 *
 * The mapping is stable within a run: one real value becomes one synthetic
 * value everywhere it appears, so a fixture set where the same candidate shows
 * up in four responses stays internally consistent and cross-file assertions
 * still mean something.
 */
const EMAIL_SHAPE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_SHAPE = /(?<!\d)(?:\(\d{3}\)\s*|\d{3}[-.])\d{3}[-.]\d{4}(?!\d)/g;
const ADDRESS_SHAPE =
  /(?:\d{1,6}|P\.?\s?O\.?\s+Box\s+\d+)\s+(?:[A-Za-z0-9.'#-]+\s+){0,5}?[A-Za-z0-9.'#-]+[\s,]{1,3}[A-Za-z][A-Za-z .'-]{2,25}?\s?,\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?/g;

/**
 * `$('.input-mask-phone').mask('(999) 999-9999')` appears in every CERS page.
 * It is a jQuery mask template, not a telephone number, and rewriting it would
 * corrupt the page for no privacy gain.
 */
const PHONE_MASK_TEMPLATE = /^\(?9{3}\)?[\s.-]*9{3}[.-]9{4}$/;

const syntheticFor = new Map<string, string>();

function synthetic(original: string, make: (index: number) => string): string {
  const existing = syntheticFor.get(original);
  if (existing !== undefined) return existing;
  const value = make(syntheticFor.size);
  syntheticFor.set(original, value);
  return value;
}

/** Rewrites every address, email and telephone shape in a string. */
function scrubContactShapes(text: string): string {
  return text
    .replace(EMAIL_SHAPE, (match) =>
      synthetic(match, (index) => `person${index}@example.invalid`),
    )
    .replace(ADDRESS_SHAPE, (match) =>
      synthetic(match, (index) => `${500 + index * 10} Example Ave, Fixtureville, MT 00000`),
    )
    .replace(PHONE_SHAPE, (match) =>
      PHONE_MASK_TEMPLATE.test(match)
        ? match
        : synthetic(match, (index) => `(406) 555-0${String(100 + (index % 100)).padStart(3, '0')}`),
    );
}

/**
 * The address *components* a shape scan cannot see.
 *
 * `"city":"Belgrade"` and `"zip5":"59714"` are PII in context and unremarkable
 * out of it, so they are handled by field name — the one place where a field
 * list is the right tool, because the field name is the only thing that makes
 * the value personal. The composite renderings CERS also ships
 * (`cityStateZip`, `addrCityStateZip`, `entityAddress`, `candidateAddress`) are
 * caught by {@link scrubContactShapes} or by the component substitution below.
 */
const ADDRESS_COMPONENTS: Record<string, string> = {
  city: 'Fixtureville',
  entityCity: 'Fixtureville',
  zip5: '00000',
  zip4: '0000',
};

const STREET_KEYS = new Set(['addrLn1', 'addrLn2']);

function scrubJsonPii(value: unknown): unknown {
  if (typeof value === 'string') return scrubContactShapes(value);
  if (Array.isArray(value)) return value.map((item) => scrubJsonPii(item));
  if (typeof value !== 'object' || value === null) return value;

  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  // Key order is preserved: a re-record must produce a diff a reader can read.
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string' && item !== '') {
      if (STREET_KEYS.has(key)) {
        out[key] = synthetic(item, (index) => `${500 + index * 10} Example Ave`);
        continue;
      }
      const replacement = ADDRESS_COMPONENTS[key];
      if (replacement !== undefined) {
        out[key] = replacement;
        continue;
      }
    }
    out[key] = scrubJsonPii(item);
  }
  return out;
}

/**
 * Applies the contact scrub to a whole recorded body, JSON or HTML.
 *
 * A JSON body is walked structurally so that field-name rules can apply; an
 * HTML body is scrubbed by shape alone. A JSON body that will not parse is
 * treated as text rather than as an error, because failing to scrub is worse
 * than scrubbing something that turned out not to be JSON.
 */
function scrubResponsePii(bytes: Uint8Array, isJson: boolean): Uint8Array {
  const text = new TextDecoder('utf-8').decode(bytes);
  if (isJson) {
    try {
      return new TextEncoder().encode(JSON.stringify(scrubJsonPii(JSON.parse(text))));
    } catch {
      // fall through to the text scrub
    }
  }
  return new TextEncoder().encode(scrubContactShapes(text));
}

function recordingTransport(inner: HttpTransport, log: TapeExchange[]): HttpTransport {
  let position: CersSessionPosition = EMPTY_SESSION;
  const seen = new Set<string>();

  return async (request: HttpRequest): Promise<HttpResponse> => {
    // Computed before the request, from the position the request was issued
    // from — which is what makes the key replayable in the same order.
    const key = cersExchangeKey(position, request);
    const response = await inner(request);
    position = advanceSession(position, request);

    const contentType = response.headers['content-type'] ?? null;
    const extension = contentType?.includes('json') === true ? 'json' : 'html';
    const file = fixtureFileName(request, key, extension);
    // Scrubbed on the way to disk only — see `scrubLineItemPii` and
    // `scrubResponsePii`. `byteSize` is the size of the file that was written,
    // not of the live response, so the tape describes what a replay will
    // actually serve.
    //
    // Two scrubs, and both are needed. The line-item one is field-driven and
    // removes a donor's occupation and employer, which have no distinguishing
    // shape and can only be found by name. The response one is shape-driven and
    // removes addresses, email addresses and telephone numbers wherever they
    // appear, which is the only way to catch the ones nobody has enumerated
    // yet — the roster's `personDTO`, a treasurer's address rendered into HTML,
    // an email typed into a free-text `comments`.
    const isJson = extension === 'json';
    const stored = scrubResponsePii(
      request.url.includes('financeRepDetailList')
        ? scrubLineItemPii(response.bytes)
        : response.bytes,
      isJson,
    );
    writeFileSync(join(OUT_DIR, file), Buffer.from(stored));

    if (!seen.has(key)) {
      seen.add(key);
      log.push({
        key,
        method: request.method,
        url: request.url,
        body: request.body ?? null,
        status: response.status,
        contentType,
        location: response.headers.location ?? null,
        setCookies: response.setCookies ?? [],
        byteSize: stored.length,
        file,
      });
    }
    console.log(`${request.method} ${short(request.url)} -> ${response.status} ${response.bytes.length}B`);
    return response;
  };
}

/**
 * A readable filename that is unique per exchange key.
 *
 * The digest is not decoration. An earlier version truncated the key to 120
 * characters, and because every key here begins with the same long search body,
 * two different exchanges produced the same filename and one silently
 * overwrote the other — a fixture set that looked complete and was not.
 */
function fixtureFileName(request: HttpRequest, key: string, extension: string): string {
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 12);
  const endpoint =
    new URL(request.url).pathname
      .replace(/;jsessionid=[^/;?]*/gi, '')
      .split('/')
      .filter((part) => part !== '')
      .pop() ?? 'root';
  return `${request.method.toLowerCase()}-${endpoint.replace(/[^A-Za-z0-9]+/g, '')}-${digest}.${extension}`;
}

function short(url: string): string {
  return url.replace(/\?sEcho.*$/, '?<datatables>').replace('https://cers-ext.mt.gov', '');
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const log: TapeExchange[] = [];

  const adapter = createMtCersAdapter({
    transport: recordingTransport(
      createPoliteTransport({ minDelayMs: 2500, userAgent: COMMISSIONWATCH_USER_AGENT }),
      log,
    ),
    // One narrow slice: the office this project actually watches. A fixture set
    // is not a mirror of the source and must not become one.
    targets: [
      {
        key: 'gallatin-county-commissioner',
        label: 'Gallatin County Commissioner',
        campaignType: CAMPAIGN_TYPE_COUNTY,
        countyCode: GALLATIN_COUNTY_CODE,
        officeCode: COUNTY_COMMISSIONER_OFFICE_CODE,
      },
    ],
    schedules: ['individual', 'expendOther'],
    maxCandidatesPerTarget: 2,
    maxReportsPerCandidate: 2,
  });

  const refs = await adapter.discoverDocuments(new Date('2026-01-01T00:00:00Z'));
  console.log(`\ndiscovered ${refs.length} refs`);
  for (const ref of refs) {
    const artifact = await adapter.fetchDocument(ref);
    console.log(`  ${artifact.byteSize}B sha=${artifact.sha256.slice(0, 12)}  ${ref.title}`);
  }

  writeFileSync(
    join(OUT_DIR, 'exchanges.json'),
    `${JSON.stringify({ recordedAt: new Date().toISOString(), exchanges: log }, null, 2)}\n`,
  );
  console.log(`\nwrote ${log.length} distinct exchanges`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
