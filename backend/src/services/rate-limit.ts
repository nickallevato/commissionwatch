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
