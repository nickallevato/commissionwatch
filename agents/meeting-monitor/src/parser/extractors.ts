import type {
  Confidence,
  ConfidenceField,
  ExtractedAgendaItem,
  ExtractedAttendee,
  ExtractedMotion,
  ExtractedQuote,
  ExtractedVote,
} from './types';

function field<T>(value: T, confidence: Confidence): ConfidenceField<T> {
  return { value, confidence };
}

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

const MONTH_ABBREVS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

export function extractDate(text: string): ConfidenceField<string | null> {
  // ISO format: 2025-01-07
  const isoMatch = text.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return field(isoMatch[1], 'high');

  // Long format: "January 7, 2025" or "January 07, 2025"
  const longMatch = text.match(
    /\b((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/i
  );
  if (longMatch) {
    const parsed = new Date(longMatch[1]);
    if (!isNaN(parsed.getTime())) {
      return field(parsed.toISOString().split('T')[0], 'high');
    }
  }

  // Abbreviated: "Jan 7, 2025"
  const abbrevMatch = text.match(
    /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4})/i
  );
  if (abbrevMatch) {
    const parsed = new Date(abbrevMatch[1]);
    if (!isNaN(parsed.getTime())) {
      return field(parsed.toISOString().split('T')[0], 'medium');
    }
  }

  // US slash format: 1/7/2025 or 01/07/2025
  const slashMatch = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (slashMatch) {
    const [, m, d, y] = slashMatch;
    return field(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`, 'medium');
  }

  return field(null, 'low');
}

export function extractTime(text: string): ConfidenceField<string | null> {
  // "6:00 PM", "6:00 p.m.", "18:00"
  const timeMatch = text.match(/\b(\d{1,2}):(\d{2})\s*(AM|PM|a\.m\.|p\.m\.)?/i);
  if (timeMatch) {
    let [, hours, minutes, meridiem] = timeMatch;
    let h = parseInt(hours, 10);
    if (meridiem) {
      const isPm = /pm|p\.m\./i.test(meridiem);
      if (isPm && h < 12) h += 12;
      if (!isPm && h === 12) h = 0;
    }
    return field(`${h.toString().padStart(2, '0')}:${minutes}`, 'high');
  }

  return field(null, 'low');
}

const TITLE_PATTERNS = [
  'mayor', 'deputy mayor', 'commissioner', 'council member',
  'city manager', 'city clerk', 'city attorney', 'chair',
];

export function extractAttendees(text: string): ConfidenceField<ExtractedAttendee[]> {
  const attendees: ExtractedAttendee[] = [];
  const lines = text.split('\n');

  // Look for roll call section
  let inRollCall = false;
  for (const line of lines) {
    const lower = line.toLowerCase().trim();

    if (/^(?:roll\s*call|attendance|members\s*present|present\s*:)/i.test(lower)) {
      inRollCall = true;
      continue;
    }

    if (inRollCall) {
      if (lower === '' || /^\s*$/.test(line)) {
        if (attendees.length > 0) break;
        continue;
      }
      // Stop on section breaks
      if (/^(agenda|minutes|motion|public\s*comment|item\s*\d)/i.test(lower)) break;

      const nameMatch = line.match(/^[\s•\-*]*(.+?)(?:\s*[-–—]\s*(present|absent))?$/i);
      if (nameMatch) {
        const raw = nameMatch[1].trim();
        if (raw.length < 3 || raw.length > 80) continue;

        let title: string | undefined;
        for (const t of TITLE_PATTERNS) {
          if (raw.toLowerCase().includes(t)) {
            title = t.replace(/\b\w/g, c => c.toUpperCase());
            break;
          }
        }

        const name = raw.replace(/\b(mayor|deputy mayor|commissioner|council member|city manager|city clerk|city attorney|chair)\b/gi, '').replace(/[,\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
        if (name.length < 2) continue;

        const absent = nameMatch[2] ? /absent/i.test(nameMatch[2]) : false;
        attendees.push({ name, title, present: !absent });
      }
    }
  }

  if (attendees.length > 0) return field(attendees, 'high');

  // Fallback: look for commissioner names near keywords
  const commissionerPattern = /(?:Commissioner|Cr\.?|Member)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g;
  let match;
  const seen = new Set<string>();
  while ((match = commissionerPattern.exec(text)) !== null) {
    const name = match[1].trim();
    if (!seen.has(name)) {
      seen.add(name);
      attendees.push({ name, title: 'Commissioner', present: true });
    }
  }

  return field(attendees, attendees.length > 0 ? 'medium' : 'low');
}

export function extractAgendaItems(text: string): ConfidenceField<ExtractedAgendaItem[]> {
  const items: ExtractedAgendaItem[] = [];
  const lines = text.split('\n');

  // Pattern: numbered items like "1.", "A.", "Item 1:", "1)"
  const itemPattern = /^\s*(?:Item\s+)?(\d+|[A-Z])[\.\):\-]\s+(.+)/i;
  // Section headers that indicate categories
  const categoryPattern = /^\s*(?:CONSENT\s*AGENDA|PUBLIC\s*HEARING|ACTION\s*ITEMS?|NEW\s*BUSINESS|OLD\s*BUSINESS|SPECIAL\s*PRESENTATION|REPORTS?)/i;

  let currentCategory: string | undefined;
  let itemNumber = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    const catMatch = line.match(categoryPattern);
    if (catMatch) {
      currentCategory = catMatch[0].trim().replace(/\s+/g, ' ');
      continue;
    }

    const itemMatch = line.match(itemPattern);
    if (itemMatch) {
      itemNumber++;
      const num = /^\d+$/.test(itemMatch[1]) ? parseInt(itemMatch[1], 10) : itemNumber;
      const title = itemMatch[2].trim();

      // Gather description from subsequent indented or non-numbered lines
      let description: string | undefined;
      const descLines: string[] = [];
      for (let j = i + 1; j < lines.length && j < i + 5; j++) {
        const next = lines[j];
        if (!next.trim()) break;
        if (itemPattern.test(next) || categoryPattern.test(next)) break;
        if (next.startsWith('  ') || next.startsWith('\t')) {
          descLines.push(next.trim());
        }
      }
      if (descLines.length > 0) {
        description = descLines.join(' ');
      }

      items.push({ itemNumber: num, title, description, category: currentCategory });
    }
  }

  return field(items, items.length > 0 ? 'high' : 'low');
}

export function extractMotions(text: string): ConfidenceField<ExtractedMotion[]> {
  const motions: ExtractedMotion[] = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const motionMatch = line.match(/(?:motion|moved)\s+(?:by\s+)?(?:Commissioner\s+|Cr\.?\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)(?=\s+to\s|\s*[.,]|\s*$)/i);
    if (!motionMatch) continue;

    const mover = motionMatch[1].trim();
    let seconder: string | undefined;
    let result: 'passed' | 'failed' | 'tabled' | undefined;
    const votes: ExtractedVote[] = [];
    let title = line.replace(motionMatch[0], '').replace(/^\s*[,;:to]+\s*/, '').trim() || 'Motion';

    // Search nearby lines for seconder, result, vote details
    for (let j = i + 1; j < lines.length && j < i + 15; j++) {
      const next = lines[j];

      const secondMatch = next.match(/second(?:ed)?\s+(?:by\s+)?(?:Commissioner\s+|Cr\.?\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
      if (secondMatch) seconder = secondMatch[1].trim();

      if (/\bpass(?:ed|es)\b|unanimously\s+approved|carried/i.test(next)) result = 'passed';
      else if (/\bfail(?:ed|s)\b|defeated/i.test(next)) result = 'failed';
      else if (/\btabled\b|postponed|deferred/i.test(next)) result = 'tabled';

      // Individual votes: "Smith - Aye", "Jones: No"
      const voteLineMatch = next.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*[-–—:]\s*(aye|yea|yes|nay|no|abstain|absent)/i);
      if (voteLineMatch) {
        const voteStr = voteLineMatch[2].toLowerCase();
        let vote: ExtractedVote['vote'] = 'yes';
        if (/nay|no/.test(voteStr)) vote = 'no';
        else if (/abstain/.test(voteStr)) vote = 'abstain';
        else if (/absent/.test(voteStr)) vote = 'absent';
        votes.push({ memberName: voteLineMatch[1].trim(), vote });
      }

      // Stop if we hit another motion
      if (j > i + 1 && /(?:motion|moved)\s+(?:by\s+)?/i.test(next)) break;
    }

    // Unanimous vote detection
    if (result === 'passed' && votes.length === 0 && /unanim/i.test(text.slice(lines.slice(0, i + 1).join('\n').length, lines.slice(0, i + 15).join('\n').length))) {
      // Leave votes empty — caller can infer unanimity from result + empty votes
    }

    motions.push({ title, mover, seconder, result, votes });
  }

  return field(motions, motions.length > 0 ? 'medium' : 'low');
}

export function extractQuotes(text: string): ConfidenceField<ExtractedQuote[]> {
  const quotes: ExtractedQuote[] = [];

  const Q = '\u0022\u201c\u201d\u201e\u201f';
  const patterns = [
    new RegExp(`[${Q}]([^${Q}]{20,300})[${Q}]\\s*(?:[-\\u2013\\u2014]\\s*|said\\s+by\\s+|,\\s*said\\s+)([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,2})`, 'g'),
    new RegExp(`([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,2})\\s+(?:said|stated|noted|commented|remarked)\\s*[,:]?\\s*[${Q}]([^${Q}]{20,300})[${Q}]`, 'g'),
  ];

  for (let i = 0; i < patterns.length; i++) {
    const pattern = patterns[i];
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (i === 0) {
        quotes.push({ speaker: match[2].trim(), text: match[1].trim() });
      } else {
        quotes.push({ speaker: match[1].trim(), text: match[2].trim() });
      }
    }
  }

  return field(quotes, quotes.length > 0 ? 'medium' : 'low');
}
