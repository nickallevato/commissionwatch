import { config } from '../config';

export class RateLimiter {
  private lastRequestTime = 0;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;

  constructor(options?: { requestsPerSecond?: number; maxRetries?: number; baseBackoffMs?: number }) {
    const rps = options?.requestsPerSecond ?? config.scraper.requestsPerSecond;
    this.minIntervalMs = Math.ceil(1000 / rps);
    this.maxRetries = options?.maxRetries ?? config.scraper.maxRetries;
    this.baseBackoffMs = options?.baseBackoffMs ?? config.scraper.baseBackoffMs;
  }

  async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minIntervalMs) {
      await sleep(this.minIntervalMs - elapsed);
    }
    this.lastRequestTime = Date.now();
  }

  async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.throttle();
      try {
        return await fn();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (!this.isRetryable(lastError) || attempt === this.maxRetries) {
          throw lastError;
        }
        const backoff = this.baseBackoffMs * Math.pow(2, attempt);
        console.warn(`Retryable error (attempt ${attempt + 1}/${this.maxRetries}): ${lastError.message}. Backing off ${backoff}ms`);
        await sleep(backoff);
      }
    }
    throw lastError;
  }

  private isRetryable(err: Error): boolean {
    const message = err.message.toLowerCase();
    return message.includes('429') || message.includes('503') || message.includes('timeout') || message.includes('econnreset');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
