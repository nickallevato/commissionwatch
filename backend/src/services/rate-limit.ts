/**
 * A fixed-window rate limiter that stores nothing about anybody.
 *
 * `POST /api/corrections/disputes` is an unauthenticated public write, so it
 * needs a limit. What it must *not* need is a row per submitter: this project
 * asks a person contesting a record about themselves for three things and no
 * more, and quietly keeping their IP address in a table to enforce a limit
 * would be collecting a fourth. So the per-client limit lives in memory, keyed
 * on a string the caller derives, and is gone when the process is.
 *
 * The honest cost of that: **a deploy resets every window.** One backend
 * container serves this product, so the limiter is not partitioned across
 * replicas, but it is erased whenever the container is recreated. That is
 * acceptable here only because it is not the whole defence — `services/disputes.ts`
 * also enforces a site-wide cap and a per-target cap, and both of those are
 * queries against durable rows rather than process memory. A restart lifts the
 * per-client window; it does not lift the ceiling on the queue.
 *
 * Fixed window rather than sliding: a sliding window needs a timestamp list per
 * key, which is unbounded memory keyed on something an attacker controls. The
 * fixed window's known weakness is a burst across a boundary — twice the limit
 * in an instant, once — and against a form whose output is a row in a moderation
 * queue that is the wrong thing to optimise for.
 *
 * No clock of its own. `now` is passed in, so the tests do not sleep.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";

export interface RateLimitDecision {
  allowed: boolean;
  /** Whole seconds until the window resets. `0` when allowed. */
  retryAfterSeconds: number;
}

interface Window {
  count: number;
  /** Epoch ms at which this window ends and the count resets. */
  resetAt: number;
}

export interface FixedWindowLimiterOptions {
  /** Requests permitted per key per window. */
  limit: number;
  windowMs: number;
  /**
   * Hard ceiling on tracked keys. The key is derived from a client-controlled
   * value, so an unbounded map is a memory-exhaustion attack with extra steps.
   * When the ceiling is hit, expired windows are dropped; if that frees
   * nothing, the *oldest* window is evicted. Evicting rather than refusing is
   * deliberate — refusing would let an attacker who filled the map deny the
   * route to everybody, which is a worse outcome than letting a stale window
   * start again.
   */
  maxKeys?: number;
}

const DEFAULT_MAX_KEYS = 10_000;

export class FixedWindowLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;

  constructor(options: FixedWindowLimiterOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  }

  /**
   * Counts one attempt against `key` and says whether it is permitted.
   *
   * A refused attempt does **not** extend the window. Extending it on refusal
   * makes a client that retries on a timer permanently locked out and unable to
   * discover when it would be allowed again, which turns a rate limit into a
   * ban nobody decided on.
   */
  check(key: string, now: Date = new Date()): RateLimitDecision {
    const stamp = now.getTime();
    this.prune(stamp);

    const existing = this.windows.get(key);
    if (existing === undefined || existing.resetAt <= stamp) {
      this.evictIfFull();
      this.windows.set(key, { count: 1, resetAt: stamp + this.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (existing.count >= this.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - stamp) / 1000)),
      };
    }

    existing.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Tracked keys. Exposed so a test can prove the map stays bounded. */
  get size(): number {
    return this.windows.size;
  }

  /** Drops the limiter's whole state. For tests, and for nothing else. */
  reset(): void {
    this.windows.clear();
  }

  private prune(stamp: number): void {
    for (const [key, window] of this.windows) {
      if (window.resetAt <= stamp) this.windows.delete(key);
    }
  }

  private evictIfFull(): void {
    if (this.windows.size < this.maxKeys) return;
    let oldestKey: string | undefined;
    let oldestReset = Number.POSITIVE_INFINITY;
    for (const [key, window] of this.windows) {
      if (window.resetAt < oldestReset) {
        oldestReset = window.resetAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.windows.delete(oldestKey);
  }
}

/* ── The public API's rate limit ─────────────────────────────────────── */

/**
 * Until 2026-08-14 the only consumer of the class above was the dispute form.
 * Every read route — the bulk export, full-text search, the whole meeting
 * archive — was unlimited, and what was actually holding the line was the Caddy
 * IP allowlist in front of the site. An allowlist is an access control, not a
 * rate limit, and taking it down is a queued operator task: on the day it comes
 * off, this file is what is left.
 *
 * **This limiter is process memory and nothing else.** It is not shared across
 * replicas and it is erased by every deploy. That is honest for this deployment
 * — one backend container, restarted on release — and it is the same trade the
 * dispute limits already make, but a reader must not mistake it for a
 * distributed limit. If this product ever runs two backends, this file is a lie
 * and needs a shared store, not a bigger number.
 *
 * Two tiers, because the costs differ by an order of magnitude.
 *
 * All three numbers below are read from the environment so an operator can
 * raise one without a code deploy — restart the container with a changed
 * value in Parameter Store / compose `environment:` and the new ceiling
 * applies from the next request. `envInt` follows the same trap `governor/model.ts`
 * documents for `GOVERNOR_MODEL`: a variable that is *set but empty* (which
 * `- FOO=${FOO:-}` in a compose file does to every var nobody supplied a value
 * for) must read as absent, not as the empty string coerced to `0` — a `0`
 * limit would silently 429 every request on the tier.
 */

/** Exported so a test can prove the parsing rules without faking a whole deploy. */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const WINDOW_MS = envInt("PUBLIC_RATE_LIMIT_WINDOW_MS", 60_000);

/**
 * `/api/search` runs four full-text queries across a four-table join per
 * request, and `/api/data/:dataset` streams an entire published dataset. Both
 * are cheap for the caller and expensive here, which is the exact shape a rate
 * limit exists for.
 *
 * Sixty a minute — one a second sustained — because the legitimate burst on
 * these routes is real and easy to describe: a researcher pulling the bulk
 * export takes twelve datasets in two formats, twenty-four requests back to
 * back, and that person is precisely who the export is for. The limit has to
 * clear that with room and still refuse a scripted hammering, so it is set a
 * little over twice the largest honest burst rather than at the smallest number
 * that would technically work.
 *
 * `PUBLIC_RATE_LIMIT_EXPENSIVE` overrides it. This is also the number quoted
 * in the 429 body and in `docs/superpowers/specs/2026-08-16-security-review.md`
 * finding 3 — if it changes, that reasoning should be re-read, not just the
 * constant.
 */
const EXPENSIVE_LIMIT = envInt("PUBLIC_RATE_LIMIT_EXPENSIVE", 60);

/**
 * Ten a second for ordinary reads. A meeting page fans out to several endpoints
 * at once and a reader clicking through the archive will genuinely produce
 * dozens of requests a minute, so this is set where a human — or a polite
 * crawler — never reaches it and a loop does immediately.
 *
 * `PUBLIC_RATE_LIMIT_DEFAULT` overrides it.
 */
const DEFAULT_LIMIT = envInt("PUBLIC_RATE_LIMIT_DEFAULT", 600);

const EXPENSIVE_PREFIXES = ["/api/search", "/api/data"];

/**
 * Not throttled at all.
 *
 * `/api/health` because a limit on a health check means an orchestrator
 * eventually gets a 429 and reads it as an outage — the probe would have caused
 * the incident it was watching for.
 *
 * `/api/admin` because it is the operator console and every route under it is
 * already behind `requireOperator`, which is a stronger wall than a counter.
 * Locking an operator out of their own console during an incident, using a
 * limit meant for anonymous readers, would be this middleware causing harm in
 * exactly the situation it is supposed to help. The exemption is by path and
 * not by session cookie on purpose: a cookie is client-controlled, so trusting
 * its presence — rather than the guard that validates it — would be a bypass
 * anyone could type. Operator routes that live outside `/api/admin`
 * (`/api/ingestion`, the detection triggers on `/api/meetings`) take the
 * default tier, which no console workflow comes near.
 */
const UNLIMITED_PREFIXES = ["/api/health", "/api/admin"];

const expensiveLimiter = new FixedWindowLimiter({
  limit: EXPENSIVE_LIMIT,
  windowMs: WINDOW_MS,
});

const defaultLimiter = new FixedWindowLimiter({
  limit: DEFAULT_LIMIT,
  windowMs: WINDOW_MS,
});

/**
 * Drops every public window. For tests, and for nothing else — the same seam
 * `resetDisputeRateLimits` provides, and for the same reason: a limiter that
 * survives between suites is cross-test state that fails whichever test happens
 * to run last.
 */
export function resetPublicRateLimits(): void {
  expensiveLimiter.reset();
  defaultLimiter.reset();
}

/** Exposed so a test can state the limits it is asserting rather than guess. */
export const PUBLIC_RATE_LIMITS = {
  windowMs: WINDOW_MS,
  expensive: EXPENSIVE_LIMIT,
  default: DEFAULT_LIMIT,
} as const;

/** `/api/data` must match `/api/data` and `/api/data/x`, but never `/api/database`. */
function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function limiterFor(path: string): FixedWindowLimiter | null {
  if (UNLIMITED_PREFIXES.some((prefix) => underPrefix(path, prefix))) return null;
  if (EXPENSIVE_PREFIXES.some((prefix) => underPrefix(path, prefix))) return expensiveLimiter;
  return defaultLimiter;
}

/**
 * Keyed on `req.ip`, which `app.set("trust proxy", 1)` makes the address Caddy
 * appended rather than Caddy's own — see the comment in `app.ts`. Without that
 * setting every reader on the internet would share one bucket and the first
 * loop of the hour would take the site down for everybody, which is a denial of
 * service wearing a rate limiter's clothes.
 */
export const publicRateLimit: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const limiter = limiterFor(req.path);
  if (limiter === null) {
    next();
    return;
  }

  const decision = limiter.check(req.ip ?? "unknown");
  if (decision.allowed) {
    next();
    return;
  }

  // `Retry-After` in seconds, so a client is told when to come back instead of
  // guessing. A 429 with no such header is an instruction to poll.
  res.setHeader("Retry-After", String(decision.retryAfterSeconds));
  res.status(429).json({
    error: rateLimitMessage(req.path, decision.retryAfterSeconds),
    statusCode: 429,
    retryAfterSeconds: decision.retryAfterSeconds,
  });
};

/**
 * A refusal on `/api/search` is the one a scripted client is most likely to
 * hit, because a script that wants "everything" and calls search in a loop to
 * get it is doing the slow, expensive way what `/api/data/*.csv` does in one
 * request. Telling that caller about the export nudges it toward the route
 * built for bulk reads instead of just making it retry search faster. Every
 * other refusal gets the plain message — `/api/data` is already the bulk
 * export, so pointing a throttled bulk reader at itself would be circular.
 */
function rateLimitMessage(path: string, retryAfterSeconds: number): string {
  if (underPrefix(path, "/api/search")) {
    return (
      `Too many search requests — try again in ${retryAfterSeconds}s. ` +
      "Pulling a large amount of data? /api/data offers the full published " +
      "record as a one-request CSV or JSON export instead of repeated searches."
    );
  }
  return "Too many requests";
}
