export interface MeetingLink {
  date: string;
  time?: string;
  location?: string;
  agendaUrl?: string;
  minutesUrl?: string;
}

export const BOZEMAN_CONFIG = {
  baseUrl: 'https://www.bozeman.net',
  archiveUrl: 'https://www.bozeman.net/government/city-commission/city-commission-archive',
  commissionPageUrl: 'https://www.bozeman.net/government/city-commission',
  commissionName: 'Bozeman City Commission',
  jurisdictionName: 'Bozeman, MT',

  selectors: {
    meetingRows: '.view-content .views-row, table.views-table tbody tr, .item-list li',
    dateCell: 'time, .date-display-single, .views-field-field-date, td:first-child',
    agendaLink: 'a[href*="agenda"], a[href*="Agenda"], a:has-text("Agenda")',
    minutesLink: 'a[href*="minutes"], a[href*="Minutes"], a:has-text("Minutes")',
    paginationNext: '.pager__item--next a, a[rel="next"], .next a',
  },

  defaults: {
    time: '18:00',
    location: 'City Hall, Commission Room, 121 N Rouse Ave, Bozeman, MT',
  },
};

export function resolveUrl(href: string): string {
  if (href.startsWith('http')) return href;
  return `${BOZEMAN_CONFIG.baseUrl}${href.startsWith('/') ? '' : '/'}${href}`;
}

export function parseMeetingDate(text: string): string | null {
  const cleaned = text.replace(/\s+/g, ' ').trim();

  // ISO date
  const isoMatch = cleaned.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];

  // US date formats: "January 7, 2025" or "Jan 7, 2025" or "1/7/2025"
  const longDateMatch = cleaned.match(
    /(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})/i
  );
  if (longDateMatch) {
    const date = new Date(cleaned);
    if (!isNaN(date.getTime())) {
      return date.toISOString().split('T')[0];
    }
  }

  const slashMatch = cleaned.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slashMatch) {
    const [, month, day, year] = slashMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  return null;
}
