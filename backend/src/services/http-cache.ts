import type { Knex } from 'knex';

/**
 * The narrow contract a caller needs. `OpenFecClient` depends on this rather
 * than on `HttpCache`, so its tests can inject an in-memory fake and stay off
 * the database.
 */
export interface CacheStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
}

interface HttpCacheRow {
  cache_key: string;
  payload: unknown;
  expires_at: Date;
}

/**
 * A TTL key/value store for outbound HTTP responses, backed by `http_cache`.
 *
 * Expiry is enforced on read as well as by the sweep: a row that has passed
 * its expiry is never served, even if the sweep has not run. The sweep exists
 * to bound table growth, not to enforce correctness.
 */
export class HttpCache implements CacheStore {
  constructor(
    private readonly db: Knex,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async get<T>(key: string): Promise<T | null> {
    const row = await this.db<HttpCacheRow>('http_cache')
      .where({ cache_key: key })
      .andWhere('expires_at', '>', new Date(this.now()))
      .first();

    return row ? (row.payload as T) : null;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    const fetchedAt = new Date(this.now());
    const expiresAt = new Date(this.now() + ttlMs);

    await this.db('http_cache')
      .insert({
        cache_key: key,
        payload: JSON.stringify(value),
        fetched_at: fetchedAt,
        expires_at: expiresAt,
      })
      .onConflict('cache_key')
      .merge(['payload', 'fetched_at', 'expires_at']);
  }

  /** Deletes expired rows. Returns how many were removed. */
  async sweepExpired(): Promise<number> {
    return this.db('http_cache').where('expires_at', '<=', new Date(this.now())).del();
  }
}
