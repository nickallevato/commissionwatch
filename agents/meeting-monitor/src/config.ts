export const config = {
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/commissionwatch',
  userAgent: 'CommissionWatch/1.0 (civic transparency tool; contact: admin@commissionwatch.org)',
  scraper: {
    requestsPerSecond: 2,
    maxRetries: 3,
    baseBackoffMs: 1000,
    timeoutMs: 30_000,
  },
};
