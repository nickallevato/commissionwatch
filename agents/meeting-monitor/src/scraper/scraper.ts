export interface ScrapeOptions {
  target: string;
  limit?: number;
  dryRun?: boolean;
}

export interface ScrapeResult {
  discovered: number;
  inserted: number;
  skipped: number;
  errors: string[];
}

export async function scrape(_options: ScrapeOptions): Promise<ScrapeResult> {
  return { discovered: 0, inserted: 0, skipped: 0, errors: [] };
}
