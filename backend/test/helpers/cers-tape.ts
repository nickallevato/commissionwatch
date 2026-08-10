import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HttpRequest, HttpResponse, HttpTransport } from '../../src/services/ingestion/adapters/http';
import {
  EMPTY_SESSION,
  advanceSession,
  cersExchangeKey,
  type CersSessionPosition,
} from '../../src/services/ingestion/adapters/mt-cers';

/**
 * Replays recorded CERS exchanges, modelling the session the way CERS does.
 *
 * A CERS response is not a function of its request. `financeRepDetailList` with
 * `listName=individual` returns whichever report was last opened in the same
 * session, so a fixture keyed on the request alone would serve one candidate's
 * contributions for every candidate — and every test would pass while proving
 * nothing. The tape is therefore keyed on {@link cersExchangeKey}, which
 * includes where the session was, and it tracks that position with
 * {@link advanceSession} — the same function the adapter uses, so the harness
 * cannot model a protocol the adapter does not follow.
 */

export interface TapeExchange {
  key: string;
  method: string;
  url: string;
  body: string | null;
  status: number;
  contentType: string | null;
  location: string | null;
  setCookies: string[];
  byteSize: number;
  file: string;
}

export interface Tape {
  recordedAt: string;
  exchanges: TapeExchange[];
}

export const CERS_FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'mt-cers');

export function loadTape(directory: string = CERS_FIXTURE_DIR): Tape {
  const raw: unknown = JSON.parse(readFileSync(join(directory, 'exchanges.json'), 'utf8'));
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as Tape).exchanges)) {
    throw new Error(`${directory}/exchanges.json is not a tape`);
  }
  return raw as Tape;
}

export class MissingExchangeError extends Error {
  constructor(
    readonly key: string,
    readonly request: HttpRequest,
  ) {
    super(
      `No recorded CERS exchange for key '${key}' (${request.method} ${request.url}). ` +
        'Re-record with `npx tsx test/fixtures/mt-cers/record.ts` if the protocol changed.',
    );
    this.name = 'MissingExchangeError';
  }
}

/**
 * A transport that answers from the tape and never touches the network.
 *
 * An unrecorded request throws rather than falling through to `fetch`. A test
 * suite that can silently reach the internet is a test suite whose green is
 * conditional on somebody else's uptime.
 */
export function createTapeTransport(
  tape: Tape,
  directory: string = CERS_FIXTURE_DIR,
): HttpTransport {
  const byKey = new Map(tape.exchanges.map((exchange) => [exchange.key, exchange]));
  let position: CersSessionPosition = EMPTY_SESSION;

  return (request: HttpRequest): Promise<HttpResponse> => {
    const key = cersExchangeKey(position, request);
    const exchange = byKey.get(key);
    if (exchange === undefined) {
      return Promise.reject(new MissingExchangeError(key, request));
    }
    position = advanceSession(position, request);

    const headers: Record<string, string> = {};
    if (exchange.contentType !== null) headers['content-type'] = exchange.contentType;
    if (exchange.location !== null) headers.location = exchange.location;

    return Promise.resolve({
      status: exchange.status,
      headers,
      setCookies: exchange.setCookies,
      bytes: new Uint8Array(readFileSync(join(directory, exchange.file))),
      finalUrl: request.url,
    });
  };
}
