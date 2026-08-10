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
    // Scrubbed on the way to disk only — see `scrubLineItemPii`. `byteSize` is
    // the size of the file that was written, not of the live response, so the
    // tape describes what a replay will actually serve.
    const stored = request.url.includes('financeRepDetailList')
      ? scrubLineItemPii(response.bytes)
      : response.bytes;
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
