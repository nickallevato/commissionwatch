/**
 * The transport, the robots parser and the document cache every adapter shares.
 *
 * All three were written for `gallatin-civicplus.ts` and none of them is about
 * Gallatin. Leaving them there would have made the second adapter either import
 * from the first — which reads as a dependency that does not exist — or carry a
 * second copy of a politeness implementation, and two copies of a rate limiter
 * is how one of them quietly stops being polite.
 *
 * `gallatin-civicplus.ts` re-exports the names it used to define, so its
 * contract suite is untouched by the move.
 */

/**
 * The honest identity every adapter fetches under: names the project and links
 * a page an operator being crawled can read. Never a browser string. Never
 * spoofed. This project's access argument depends on it being true.
 */
export const COMMISSIONWATCH_USER_AGENT =
  'CommissionWatch/0.1 (civic transparency project; +https://commissionwatch.bmux.sh; admin@bmux.sh)';

/** Default gap between two requests when an adapter states none. */
export const DEFAULT_MIN_DELAY_MS = 2000;

export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * How many times a request is retried after a *transient* failure.
 *
 * Two, so a request gets three goes in total. Deliberately small: the job queue
 * behind this transport already retries with its own backoff, and stacking a
 * generous in-request retry on top of that turns one unlucky night into a
 * multiplied hammering of a county web server. This layer exists for the
 * failure the queue handles badly — a single timed-out or rate-limited request
 * inside an otherwise good pass — not as a second retry budget.
 */
export const DEFAULT_MAX_RETRIES = 2;

/**
 * The longest `Retry-After` this transport will actually wait out.
 *
 * A server asking for two minutes gets two minutes. A server asking for an hour
 * gets the request abandoned and the job returned to the queue, which will come
 * back later anyway — holding a worker idle for an hour would stall every other
 * source behind it.
 */
export const MAX_RETRY_AFTER_MS = 120_000;

/** Statuses that mean "not now, come back" rather than "no". */
const BACKOFF_STATUSES = new Set([429, 503]);

/**
 * A request that never produced a response, with enough context to diagnose it.
 *
 * **The original failure is carried verbatim in `reason`, never replaced.** A
 * connection reset is not a timeout, and an error class that flattened both
 * into "aborted" would be the same loss of information it exists to fix.
 *
 * The reason this class exists: on 2026-08-16 Gallatin's discover stage failed
 * in production with exactly `AbortError: This operation was aborted` — no URL,
 * no elapsed time, no indication of which of a dozen requests had been in
 * flight. The failure could not be diagnosed from its own logs, and probing the
 * source from outside could not reproduce it. An error that cannot say what it
 * was doing is a failure to observe, not a failure to handle.
 */
export class HttpRequestFailed extends Error {
  constructor(
    readonly url: string,
    readonly elapsedMs: number,
    readonly timeoutMs: number,
    readonly attempts: number,
    /** The underlying failure, verbatim — `AbortError: …`, `TypeError: fetch failed`, … */
    readonly reason: string,
  ) {
    super(
      `request to ${url} failed after ${elapsedMs}ms ` +
        `(${attempts} attempt${attempts === 1 ? '' : 's'}, ${timeoutMs}ms timeout): ${reason}`,
    );
    this.name = 'HttpRequestFailed';
  }

  /** True when this was our own timer rather than the host or the network. */
  get timedOut(): boolean {
    return this.reason.startsWith('AbortError');
  }
}

/**
 * `Retry-After` in milliseconds — delta-seconds or an HTTP-date — or null.
 *
 * Null for an absent, unparseable or past date, so a malformed header falls
 * through to ordinary backoff rather than being read as "retry immediately",
 * which is the reading that turns a rate limit into a hammering.
 */
export function parseRetryAfter(header: string | undefined, now: number): number | null {
  if (header === undefined) return null;
  const text = header.trim();
  if (text === '') return null;

  if (/^\d+$/.test(text)) return Number(text) * 1000;

  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  const delta = at - now;
  return delta > 0 ? delta : null;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  /** Form-encoded body, for the one endpoint that takes a POST. */
  body?: string;
  /** Extra request headers. The transport supplies the user agent. */
  headers?: Record<string, string>;
  /**
   * Redirect handling. Defaults to `'follow'`, which is right for a document.
   *
   * `'manual'` exists for a source that sets a cookie on a redirect: `fetch`
   * exposes only the final response's headers, so a `Set-Cookie` on a 302 is
   * invisible to a caller that let the transport follow it. CERS mints its
   * session exactly that way, and following blindly produced a search that
   * returned zero rows while reporting HTTP 200 — a silent wrong answer, which
   * is worse than an error.
   */
  redirect?: RedirectMode;
}

export interface HttpResponse {
  status: number;
  /** Header names lowercased. */
  headers: Record<string, string>;
  /**
   * Every `Set-Cookie` value, unfolded.
   *
   * `headers` is a flat map and a response may set several cookies, so exactly
   * one of them survives there — the last one wins and the rest are gone. CERS
   * sets three at once, `JSESSIONID` among them, and losing it made every
   * search run in a fresh session and return zero rows under HTTP 200. Cookies
   * therefore have their own field rather than being read out of `headers`.
   *
   * Optional because a transport with no cookie concept — every fixture double
   * in this repo — legitimately reports none, and absent is the honest value
   * for that. `createPoliteTransport` always populates it.
   */
  setCookies?: string[];
  bytes: Uint8Array;
  /** The URL after redirects. */
  finalUrl: string;
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

export class HttpStatusError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`HTTP ${status} fetching ${url}`);
    this.name = 'HttpStatusError';
  }
}

export class RobotsDisallowedError extends Error {
  constructor(readonly url: string) {
    super(`robots.txt disallows ${url}`);
    this.name = 'RobotsDisallowedError';
  }
}

export class OffSourceUrlError extends Error {
  constructor(
    readonly url: string,
    readonly allowedOrigins: string[],
  ) {
    super(`${url} is outside the declared surface (${allowedOrigins.join(', ')})`);
    this.name = 'OffSourceUrlError';
  }
}

/**
 * `RequestRedirect` verbatim. Spelled out rather than imported from the DOM lib,
 * because the backend's tsconfig deliberately carries no `DOM` lib — a server
 * that can name `document` is a server that can accidentally use it.
 */
export type RedirectMode = 'follow' | 'error' | 'manual';

export interface FetchLikeInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect: RedirectMode;
  signal: AbortSignal;
}

/**
 * Exactly the slice of `fetch` this transport uses. Narrower than `typeof fetch`
 * so a test double is an ordinary function rather than something cast into shape.
 */
export type FetchLike = (input: string, init: FetchLikeInit) => Promise<Response>;

export interface PoliteTransportOptions {
  userAgent?: string;
  /** Floor on the gap between two requests. */
  minDelayMs?: number;
  timeoutMs?: number;
  /** Retries after a transient failure. Defaults to {@link DEFAULT_MAX_RETRIES}. */
  maxRetries?: number;
  /**
   * Told when a request is retried, so a stall is visible in the log rather
   * than only in a wall-clock that looks slow.
   */
  onRetry?: (detail: { url: string; attempt: number; waitMs: number; reason: string }) => void;
  /** Injected for tests; defaults to global `fetch`. */
  fetchImpl?: FetchLike;
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Splits a folded `Set-Cookie` header back into individual cookies.
 *
 * The fallback for a transport whose headers object predates `getSetCookie`.
 * It splits on the comma that precedes a `name=` pair rather than on every
 * comma, because an `Expires=Wed, 09 Jun 2027 …` attribute contains one and
 * splitting naively truncates that cookie and invents another.
 */
export function splitSetCookieHeader(header: string | undefined): string[] {
  if (header === undefined || header === '') return [];
  return header.split(/,\s*(?=[^;=\s]+=)/);
}

/**
 * The politeness lives here rather than in the adapter so that a fixture-backed
 * transport runs at test speed without the adapter having a "skip the delay"
 * switch that could ever be flipped in production. One request in flight at a
 * time, `minDelayMs` between them.
 */
export function createPoliteTransport(options: PoliteTransportOptions = {}): HttpTransport {
  const userAgent = options.userAgent ?? COMMISSIONWATCH_USER_AGENT;
  const minDelayMs = options.minDelayMs ?? DEFAULT_MIN_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? realSleep;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const onRetry = options.onRetry ?? ((): void => undefined);
  const doFetch: FetchLike = options.fetchImpl ?? fetch;

  let lastRequestAt = Number.NEGATIVE_INFINITY;
  // Serializes requests: maxConcurrency is 1, and it is 1 because the queue is a chain.
  let queue: Promise<unknown> = Promise.resolve();

  /**
   * Exponential backoff between attempts, floored at the politeness delay.
   *
   * Never *shorter* than `minDelayMs`: a retry is still a request to the same
   * host, and a transport that backed off faster than it crawls would answer a
   * server's "slow down" by speeding up.
   */
  function backoffMs(attempt: number): number {
    return Math.max(minDelayMs, minDelayMs * 2 ** attempt);
  }

  async function attemptOnce(
    request: HttpRequest,
  ): Promise<{ ok: true; response: HttpResponse; status: number; retryAfter: string | undefined } | { ok: false; elapsedMs: number; reason: string }> {
    const waitMs =
      lastRequestAt === Number.NEGATIVE_INFINITY ? 0 : lastRequestAt + minDelayMs - now();
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    lastRequestAt = now();
    const startedAt = now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        'User-Agent': userAgent,
        ...(request.headers ?? {}),
      };
      if (request.method === 'POST' && request.body !== undefined) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }

      const init: FetchLikeInit = {
        method: request.method,
        headers,
        redirect: request.redirect ?? 'follow',
        signal: controller.signal,
      };
      if (request.method === 'POST' && request.body !== undefined) {
        init.body = request.body;
      }
      const response = await doFetch(request.url, init);

      const flat: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        flat[name.toLowerCase()] = value;
      });
      // `getSetCookie` is the only API that returns them unfolded. It is
      // guarded rather than assumed because `FetchLike` is deliberately narrow
      // and a test double supplies its own Headers-shaped object.
      const setCookies =
        typeof response.headers.getSetCookie === 'function'
          ? response.headers.getSetCookie()
          : splitSetCookieHeader(flat['set-cookie']);

      // 304 carries no body; asking for one is not an error, it is just empty.
      const bytes =
        response.status === 304 ? new Uint8Array(0) : new Uint8Array(await response.arrayBuffer());

      return {
        ok: true,
        status: response.status,
        retryAfter: flat['retry-after'],
        response: {
          status: response.status,
          headers: flat,
          setCookies,
          bytes,
          finalUrl: response.url === '' ? request.url : response.url,
        },
      };
    } catch (error) {
      // Every failure here is a *transport* failure — the request never
      // produced a response. The elapsed time is captured at the point of
      // failure rather than reconstructed later, because it is the one number
      // that distinguishes "the host went quiet" from "we gave up early".
      return {
        ok: false,
        elapsedMs: now() - startedAt,
        reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One request, with retries for the failures that are worth retrying.
   *
   * Three kinds of outcome and three different answers:
   *
   *  - **A response, any status other than 429/503** — returned as-is. Deciding
   *    what a 403 or a 404 means is the adapter's job, not the transport's, and
   *    a transport that retried them would turn a refusal into a hammering.
   *  - **429 or 503** — the server asking for time. `Retry-After` is honoured
   *    when it is present and sane, and ordinary backoff used when it is not.
   *    After the last attempt the response is *returned* rather than thrown, so
   *    the adapter still sees the status the server actually sent.
   *  - **No response at all** (timeout, connection reset, DNS) — retried, then
   *    raised as `HttpTimeoutError` naming the URL and how long it ran.
   */
  async function perform(request: HttpRequest): Promise<HttpResponse> {
    let lastElapsedMs = 0;
    let lastReason = 'no attempt was made';

    for (let attempt = 0; ; attempt += 1) {
      const outcome = await attemptOnce(request);

      if (outcome.ok && !BACKOFF_STATUSES.has(outcome.status)) {
        return outcome.response;
      }

      const isLast = attempt >= maxRetries;

      if (outcome.ok) {
        // 429 or 503.
        if (isLast) return outcome.response;
        const asked = parseRetryAfter(outcome.retryAfter, now());
        const waitMs =
          asked === null ? backoffMs(attempt) : Math.min(asked, MAX_RETRY_AFTER_MS);
        onRetry({
          url: request.url,
          attempt: attempt + 1,
          waitMs,
          reason: `HTTP ${outcome.status}${asked === null ? '' : ` (Retry-After ${asked}ms)`}`,
        });
        await sleep(waitMs);
        continue;
      }

      lastElapsedMs = outcome.elapsedMs;
      lastReason = outcome.reason;
      if (isLast) {
        throw new HttpRequestFailed(
          request.url,
          lastElapsedMs,
          timeoutMs,
          attempt + 1,
          lastReason,
        );
      }
      const waitMs = backoffMs(attempt);
      onRetry({ url: request.url, attempt: attempt + 1, waitMs, reason: lastReason });
      await sleep(waitMs);
    }
  }

  return (request: HttpRequest): Promise<HttpResponse> => {
    const result = queue.then(() => perform(request));
    // The chain itself must never reject, or one failed request poisons every later one.
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

export interface RobotsRule {
  allow: boolean;
  path: string;
}

/**
 * The `User-agent: *` group of a robots.txt, plus any group naming us. Deliberately
 * small: prefix rules with `*` and `$`, longest match wins, `Allow` wins a tie — which is
 * what the REP says and all Gallatin's file needs.
 */
export function parseRobotsTxt(text: string, userAgentToken: string): RobotsRule[] {
  const token = userAgentToken.toLowerCase();
  const groups = new Map<string, RobotsRule[]>();
  let currentAgents: string[] = [];
  let expectingAgents = true;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (!expectingAgents) {
        currentAgents = [];
        expectingAgents = true;
      }
      currentAgents.push(value.toLowerCase());
      continue;
    }

    if (field !== 'allow' && field !== 'disallow') continue;
    expectingAgents = false;
    if (value === '') continue;
    for (const agent of currentAgents) {
      const rules = groups.get(agent) ?? [];
      rules.push({ allow: field === 'allow', path: value });
      groups.set(agent, rules);
    }
  }

  // A group naming us beats the wildcard group; that is the REP's precedence.
  for (const [agent, rules] of groups) {
    if (agent !== '*' && token.includes(agent)) {
      return rules;
    }
  }
  return groups.get('*') ?? [];
}

function robotsPatternToRegExp(pattern: string): RegExp {
  let source = '';
  for (const character of pattern) {
    if (character === '*') {
      source += '.*';
    } else if (character === '$') {
      source += '$';
    } else {
      source += character.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}`);
}

/** True when `pathname` (with query) is fetchable under `rules`. */
export function isAllowedByRobots(rules: RobotsRule[], pathname: string): boolean {
  let best: { length: number; allow: boolean } | null = null;
  for (const rule of rules) {
    if (!robotsPatternToRegExp(rule.path).test(pathname)) continue;
    const length = rule.path.length;
    if (best === null || length > best.length || (length === best.length && rule.allow)) {
      best = { length, allow: rule.allow };
    }
  }
  return best === null ? true : best.allow;
}

// ---------------------------------------------------------------------------
// Document cache
// ---------------------------------------------------------------------------

export interface CachedDocument {
  bytes: Uint8Array;
  contentType: string | null;
  sourceUrl: string;
  etag?: string;
  lastModified?: string;
}

export interface DocumentCache {
  get(url: string): CachedDocument | undefined;
  set(url: string, entry: CachedDocument): void;
}

export function createMemoryDocumentCache(): DocumentCache {
  const entries = new Map<string, CachedDocument>();
  return {
    get: (url) => entries.get(url),
    set: (url, entry) => {
      entries.set(url, entry);
    },
  };
}
