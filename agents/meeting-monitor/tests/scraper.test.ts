import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scrape, ScrapeOptions } from '../src/scraper/scraper';
import { parseMeetingDate, resolveUrl, BOZEMAN_CONFIG } from '../src/scraper/bozeman-commission';
import { RateLimiter } from '../src/scraper/rate-limiter';

describe('parseMeetingDate', () => {
  it('parses ISO date format', () => {
    expect(parseMeetingDate('2025-01-07')).toBe('2025-01-07');
  });

  it('parses long US date format', () => {
    expect(parseMeetingDate('January 7, 2025')).toBe('2025-01-07');
  });

  it('parses abbreviated month format', () => {
    expect(parseMeetingDate('Mar 15, 2025')).toBe('2025-03-15');
  });

  it('parses slash date format', () => {
    expect(parseMeetingDate('1/7/2025')).toBe('2025-01-07');
  });

  it('parses slash date with zero padding', () => {
    expect(parseMeetingDate('12/31/2025')).toBe('2025-12-31');
  });

  it('handles extra whitespace', () => {
    expect(parseMeetingDate('  January  7,  2025  ')).toBe('2025-01-07');
  });

  it('returns null for unparseable text', () => {
    expect(parseMeetingDate('TBD')).toBeNull();
    expect(parseMeetingDate('')).toBeNull();
  });
});

describe('resolveUrl', () => {
  it('returns absolute URLs unchanged', () => {
    expect(resolveUrl('https://example.com/doc.pdf')).toBe('https://example.com/doc.pdf');
  });

  it('prepends base URL to relative paths', () => {
    expect(resolveUrl('/documents/agenda.pdf')).toBe(
      `${BOZEMAN_CONFIG.baseUrl}/documents/agenda.pdf`
    );
  });

  it('handles relative paths without leading slash', () => {
    expect(resolveUrl('documents/agenda.pdf')).toBe(
      `${BOZEMAN_CONFIG.baseUrl}/documents/agenda.pdf`
    );
  });
});

describe('RateLimiter', () => {
  it('throttles requests to respect rate limit', async () => {
    const limiter = new RateLimiter({ requestsPerSecond: 10 });
    const start = Date.now();

    await limiter.throttle();
    await limiter.throttle();
    await limiter.throttle();

    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(180);
  });

  it('retries on retryable errors', async () => {
    const limiter = new RateLimiter({ requestsPerSecond: 100, maxRetries: 2, baseBackoffMs: 10 });
    let attempts = 0;

    const result = await limiter.withRetry(async () => {
      attempts++;
      if (attempts < 3) throw new Error('HTTP 503 Service Unavailable');
      return 'success';
    });

    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });

  it('throws on non-retryable errors immediately', async () => {
    const limiter = new RateLimiter({ requestsPerSecond: 100, maxRetries: 3, baseBackoffMs: 10 });
    let attempts = 0;

    await expect(
      limiter.withRetry(async () => {
        attempts++;
        throw new Error('404 Not Found');
      })
    ).rejects.toThrow('404 Not Found');

    expect(attempts).toBe(1);
  });
});

describe('scrape', () => {
  it('rejects unsupported targets', async () => {
    await expect(scrape({ target: 'unknown' })).rejects.toThrow('Unsupported target: unknown');
  });

  it('accepts bozeman target with dry-run mode', async () => {
    const result = await scrape({ target: 'bozeman', dryRun: true, limit: 1 });
    expect(result).toHaveProperty('discovered');
    expect(result).toHaveProperty('inserted', 0);
    expect(result).toHaveProperty('skipped', 0);
    expect(result).toHaveProperty('errors');
  });
});
