import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scrape } from '../src/scraper/scraper';

const ARCHIVE_HTML = `
<html><body>
<div class="view-content">
  <div class="views-row">
    <time datetime="2025-04-07">April 7, 2025</time>
    <a href="/documents/agenda-2025-04-07.pdf">Agenda</a>
    <a href="/documents/minutes-2025-04-07.html">Minutes</a>
  </div>
  <div class="views-row">
    <time datetime="2025-03-17">March 17, 2025</time>
    <a href="/documents/agenda-2025-03-17.pdf">Agenda</a>
  </div>
  <div class="views-row">
    <time datetime="2025-03-03">March 3, 2025</time>
    <a href="https://www.bozeman.net/documents/minutes-2025-03-03.html">Minutes</a>
  </div>
  <div class="views-row">
    <span class="date-display-single">February 18, 2025</span>
    <a href="/docs/agenda-feb.pdf">View Agenda</a>
    <a href="/docs/minutes-feb.html">View Minutes</a>
  </div>
</div>
</body></html>`;

const PAGE2_HTML = `
<html><body>
<div class="view-content">
  <div class="views-row">
    <time datetime="2025-01-06">January 6, 2025</time>
    <a href="/documents/agenda-2025-01-06.pdf">Agenda</a>
    <a href="/documents/minutes-2025-01-06.html">Minutes</a>
  </div>
</div>
</body></html>`;

const PAGINATED_ARCHIVE_HTML = `
<html><body>
<div class="view-content">
  <div class="views-row">
    <time datetime="2025-04-07">April 7, 2025</time>
    <a href="/documents/agenda-2025-04-07.pdf">Agenda</a>
  </div>
</div>
<div class="pager__item--next"><a href="/archive?page=2">Next</a></div>
</body></html>`;

const commissionId = '11111111-1111-1111-1111-111111111111';
const meetingId = '22222222-2222-2222-2222-222222222222';

const mockFirst = vi.fn();
const mockReturning = vi.fn();
const mockInsert = vi.fn();
const mockWhere = vi.fn();
const mockJoin = vi.fn();
const mockSelect = vi.fn();

function buildMockDb() {
  const tableHandlers: Record<string, any> = {
    commissions: {
      join: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue({ id: commissionId }),
          }),
        }),
      }),
    },
    meetings: {
      where: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(null),
      }),
      insert: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: meetingId }]),
      }),
    },
    meeting_documents: {
      insert: vi.fn().mockResolvedValue(undefined),
    },
  };

  return (table: string) => tableHandlers[table];
}

vi.mock('../src/db', () => ({
  getDb: vi.fn(() => buildMockDb()),
}));

vi.mock('../src/config', () => ({
  config: {
    databaseUrl: 'postgresql://localhost/test',
    userAgent: 'TestAgent/1.0',
    scraper: {
      requestsPerSecond: 100,
      maxRetries: 0,
      baseBackoffMs: 10,
      timeoutMs: 5000,
    },
  },
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('scraper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(ARCHIVE_HTML),
    });
  });

  it('rejects unsupported targets', async () => {
    await expect(scrape({ target: 'unknown' })).rejects.toThrow('Unsupported target');
  });

  it('discovers meetings from archive HTML', async () => {
    const result = await scrape({ target: 'bozeman', dryRun: true });
    expect(result.discovered).toBe(4);
    expect(result.inserted).toBe(4);
    expect(result.skipped).toBe(0);
  });

  it('respects the limit option', async () => {
    const result = await scrape({ target: 'bozeman', limit: 2, dryRun: true });
    expect(result.discovered).toBe(2);
    expect(result.inserted).toBe(2);
  });

  it('follows pagination links', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(PAGINATED_ARCHIVE_HTML) })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(PAGE2_HTML) });

    const result = await scrape({ target: 'bozeman', dryRun: true });
    expect(result.discovered).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('resolves relative URLs to absolute', async () => {
    const singleMeetingHtml = `
    <html><body><div class="view-content">
      <div class="views-row">
        <time datetime="2025-04-07">April 7, 2025</time>
        <a href="/documents/agenda.pdf">Agenda</a>
      </div>
    </div></body></html>`;

    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve(singleMeetingHtml) });

    const result = await scrape({ target: 'bozeman', dryRun: true });
    expect(result.discovered).toBe(1);
  });

  it('handles HTTP errors in fetch', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('') });

    await expect(scrape({ target: 'bozeman' })).rejects.toThrow('HTTP 500');
  });
});
