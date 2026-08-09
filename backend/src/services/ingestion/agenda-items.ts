/**
 * Agenda items out of a document's lines.
 *
 * Pure, synchronous, no IO — so it is fully testable, and so a parser fix can be
 * replayed against artifact bytes already held rather than against a county web
 * server.
 *
 * Written against a real Gallatin agenda pulled 2026-08-09
 * (`/AgendaCenter/ViewFile/Agenda/_06042026-107`), which is shaped like this:
 *
 *     AGENDA
 *     I. PUBLIC COMMENT (Limited to 5 minutes unless special request is granted)
 *     II. MINUTES - April 2, 2026
 *     III. OLD BUSINESS
 *     1. Outstanding Noxious Weed Management Award
 *     IV. NEW BUSINESS
 *     1. Monthly Report Q&A
 *     ...
 *     3. Coordinators Report
 *     - Grants Update
 *     - Events/Projects/Trainings
 *
 * Two things follow from that and are the whole design:
 *
 * 1. **Numbering restarts inside every section.** "1." appears under OLD BUSINESS
 *    and again under NEW BUSINESS. `agenda_items.item_number` is therefore a
 *    document-wide ordinal, not the marker the page prints, and the section it
 *    sat under is preserved as `category` so nothing about the record is lost.
 * 2. **Roman numerals are sections, arabic numerals are items** — on this
 *    document. That cannot be assumed universally, so the classifier asks
 *    whether the text after the marker reads as a heading rather than trusting
 *    the numeral style alone.
 *
 * The extractor describes what the document contains. It draws no conclusion
 * about any of it.
 */

/** `agenda_items.title` and `.category` are knex's default varchar(255). */
const VARCHAR_255 = 255;

/** A description longer than this is a page of prose, not an item's subpoints. */
const MAX_DESCRIPTION = 2000;

export interface AgendaItemDraft {
  /** Document-wide ordinal, 1-based. Maps to `agenda_items.item_number`. */
  itemNumber: number;
  /** The marker the document printed, e.g. `3` or `B`. Kept for the title's sake. */
  marker: string;
  /** `agenda_items.title`. */
  title: string;
  /** `agenda_items.description`, or null when the item had no subpoints. */
  description: string | null;
  /** `agenda_items.category` — the section heading the item sat under. */
  category: string | null;
}

/** `I.`, `IV)`, `XII.` — a marker made only of roman numeral letters. */
const ROMAN = /^[IVXLCDM]+$/;

/** `1.`, `12)`, `A.`, `IV.` — a marker at the start of a line. */
const MARKED_LINE = /^(?:Item\s+)?([0-9]{1,3}|[A-Za-z]|[IVXLCDM]{1,7})\s*[-.):]\s+(\S.*)$/;

/** `-`, `•`, `*`, `o` used as a bullet under an item. */
const BULLET = /^[•·▪◦*•▪–—-]\s+(\S.*)$/;

/**
 * Headings an agenda uses without any numbering at all. Matched whole-line and
 * case-insensitively, because "Consent Agenda" and "CONSENT AGENDA" are the same
 * heading.
 */
const BARE_HEADINGS =
  /^(?:consent\s+agenda|public\s+(?:comment|hearings?)|action\s+items?|new\s+business|old\s+business|unfinished\s+business|special\s+presentations?|presentations?|reports?|announcements?|adjournment?|call\s+to\s+order|roll\s+call|approval\s+of\s+minutes|minutes|work\s+session|executive\s+session)\b/i;

function clamp(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

/** Fraction of the cased letters in `text` that are upper case. 1 when none. */
function upperCaseRatio(text: string): number {
  const cased = text.replace(/[^A-Za-z]/g, "");
  if (cased.length === 0) return 1;
  const upper = cased.replace(/[^A-Z]/g, "").length;
  return upper / cased.length;
}

/**
 * True when a marked line reads as a section heading rather than as an item.
 *
 * A roman marker is the strong signal, but only when the text behind it also
 * looks like a heading — mostly upper case, or a heading word we recognise.
 * "I. Approve the contract with Smith Excavating" is an item that happens to
 * start with the letter I, and treating it as a section would lose it entirely.
 */
function readsAsHeading(marker: string, text: string): boolean {
  if (BARE_HEADINGS.test(text)) return true;
  if (!ROMAN.test(marker.toUpperCase())) return false;
  return upperCaseRatio(text) >= 0.7;
}

/**
 * True when a line is boilerplate that appears above or beside the agenda
 * proper — accessibility notices, phone numbers, addresses — and would otherwise
 * be swept into an item's description.
 */
function isChrome(line: string): boolean {
  if (/^page\s+\d+(\s+of\s+\d+)?$/i.test(line)) return true;
  if (/^\d+\s*$/.test(line)) return true;
  return false;
}

export interface AgendaExtraction {
  items: AgendaItemDraft[];
  /**
   * Whether the document declared itself an agenda. Reported, not enforced:
   * a document that never says "AGENDA" may still be one, and the caller
   * decides what to do with a weak result.
   */
  sawAgendaHeading: boolean;
}

export function extractAgendaItems(lines: string[]): AgendaExtraction {
  const items: AgendaItemDraft[] = [];
  const descriptions: string[][] = [];
  let category: string | null = null;
  let sawAgendaHeading = false;

  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line === "" || isChrome(line)) continue;

    if (/^agendas?$/i.test(line)) {
      sawAgendaHeading = true;
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet && items.length > 0) {
      descriptions[descriptions.length - 1].push(bullet[1]);
      continue;
    }

    const marked = MARKED_LINE.exec(line);
    if (marked) {
      const marker = marked[1];
      const text = marked[2];
      if (readsAsHeading(marker, text)) {
        category = clamp(`${marker}. ${text}`, VARCHAR_255);
        continue;
      }
      items.push({
        itemNumber: items.length + 1,
        marker,
        title: clamp(text, VARCHAR_255),
        description: null,
        category,
      });
      descriptions.push([]);
      continue;
    }

    // An unmarked heading, e.g. a bare "NEW BUSINESS" line.
    if (BARE_HEADINGS.test(line) && upperCaseRatio(line) >= 0.7) {
      category = clamp(line, VARCHAR_255);
      continue;
    }

    // A continuation of the item above: a wrapped title reads as lower case at
    // the start, where a new heading does not.
    if (items.length > 0 && /^[a-z(]/.test(line)) {
      descriptions[descriptions.length - 1].push(line);
    }
  }

  for (let index = 0; index < items.length; index += 1) {
    const parts = descriptions[index];
    items[index].description =
      parts.length === 0 ? null : clamp(parts.join(" "), MAX_DESCRIPTION);
  }

  return { items, sawAgendaHeading };
}
