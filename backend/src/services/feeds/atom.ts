/**
 * Atom 1.0 and RSS 2.0, rendered from one entry shape.
 *
 * Pure on purpose, exactly like `renderSitemap`: the document can be asserted
 * character by character, the ordering does not depend on what the database
 * returned first, and the two formats cannot drift into disagreeing about what
 * an entry says because they are two functions over one struct.
 *
 * Three properties here are not stylistic.
 *
 * **`<id>` is a URN over the event id, never the URL.** A feed reader keys its
 * "have I shown this?" state on the id. Key it on a URL and the day a path
 * changes — `/meetings/{id}` gaining a slug, the host moving — every reader
 * re-shows every item as new. The event id is the one identifier that is
 * already permanent, because migration 083 keeps event rows forever.
 *
 * **Every entry carries a citation.** `FeedEntry.citation` is required, not
 * optional, so an entry with nothing to point at cannot be constructed. A feed
 * item that leaves the source behind is an unsourced claim sitting in a
 * stranger's inbox with our name on it.
 *
 * **Retractions are entries.** A feed that only ever adds propagates a mistake
 * and never the correction, which is the opposite of what this project asks of
 * the bodies it watches. `retraction: true` puts the withdrawal in the title,
 * where a reader skimming subject lines sees it.
 */

/** Where the assertion came from. Required on every entry. */
export interface FeedCitation {
  /** What a reader is told they are clicking. Never generated prose. */
  label: string;
  /** Absolute. Either an on-site record or the upstream document we fetched. */
  url: string;
  /**
   * The content address of the stored artifact, when the citation is one.
   * Carried in the text so the address survives the hop even if the link rots
   * — which is the whole argument for a content address in the first place.
   */
  sha256: string | null;
}

export interface FeedEntry {
  /** The event id, or `{kind}:{id}` for a search result. Not a URL. */
  urn: string;
  title: string;
  /** Plain text. No markup, because the sources are third-party PDF scrapes. */
  summary: string;
  /** Absolute, on-site. A claim is not a page — it is `#claim-{id}` in a meeting. */
  url: string;
  updated: Date;
  /** True for a `*.retracted` event. Changes the title, not just a flag. */
  retraction: boolean;
  citation: FeedCitation;
}

export interface FeedDocument {
  /** Absolute URL of this feed, query string included. Atom requires it. */
  selfUrl: string;
  /** The site root, for the alternate link. */
  homeUrl: string;
  title: string;
  subtitle: string;
  /** Newest entry's `occurred_at`, or the epoch when there are none. */
  updated: Date;
  entries: FeedEntry[];
}

export const FEED_AUTHOR = "CommissionWatch";

/**
 * `&`, `<` and `>` break a parser; `"` breaks an attribute, and this document
 * has attributes (`href`, `rel`, `type`) that carry caller-controlled URLs and
 * the echoed query. The sitemap could skip the quote entity because it has no
 * attributes at all. This cannot.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * XML 1.0 allows exactly three C0 characters — tab, newline, carriage return.
 * Any other control character makes the whole document unparseable, so one
 * stray byte does not degrade an entry, it takes the feed down for every
 * reader.
 *
 * This is on the live path, not hypothetical: `services/search.ts` deliberately
 * marks matches with `chr(2)`/`chr(3)` rather than `<b>`, to avoid handing the
 * frontend markup built out of scraped PDFs. Those delimiters arrive here on
 * every query-feed snippet.
 */
function stripControls(value: string): string {
  // Written as escapes, never as literals: a control character typed into
  // this file would be invisible in every diff and editor that touched it,
  // the same reason `search.ts` builds its delimiters with `chr()`.
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/** The one function anything caller-controlled goes through. */
export function xmlText(value: string): string {
  return escapeXml(stripControls(value));
}

/** The stable identity a reader's client keys on. */
export function eventUrn(eventId: string): string {
  return `urn:uuid:${eventId}`;
}

/**
 * A search result is not an announcement, so it has no event id. It still needs
 * an id that is stable across renders and is not a URL, so it gets one in this
 * project's own namespace, built from the kind and the row's primary key.
 */
export function searchUrn(kind: string, id: string): string {
  return `urn:commissionwatch:${kind}:${id}`;
}

function rfc3339(date: Date): string {
  return date.toISOString();
}

const RFC822_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const RFC822_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * RSS 2.0 dates are RFC 822, which `toISOString` is not and `toUTCString` is
 * only by coincidence of format. Written out so the output does not depend on
 * the host's locale — a `pubDate` in the runner's language is a date half the
 * readers parse as absent.
 */
function rfc822(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${RFC822_DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ` +
    `${RFC822_MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} GMT`
  );
}

/**
 * The citation as text, appended to the entry body in both formats.
 *
 * In the body rather than only in a `<link rel="via">` because most readers
 * render the body and ignore unfamiliar link relations, and an entry whose
 * citation is only visible to a well-behaved parser is an entry most people
 * read without one.
 */
function citationText(citation: FeedCitation): string {
  const address = citation.sha256 === null ? "" : ` (sha256 ${citation.sha256})`;
  return `Source: ${citation.label}${address} — ${citation.url}`;
}

function entryBody(entry: FeedEntry): string {
  const summary = entry.summary.trim();
  return summary.length === 0
    ? citationText(entry.citation)
    : `${summary}\n\n${citationText(entry.citation)}`;
}

export function renderAtom(doc: FeedDocument): string {
  const entries = doc.entries
    .map((entry) => {
      // `rel="via"` is the registered relation for "where this information came
      // from". Readers that understand it get a second, machine-readable path
      // to the source; readers that do not still have it in the body above.
      return (
        "  <entry>\n" +
        `    <id>${xmlText(entry.urn)}</id>\n` +
        `    <title>${xmlText(entry.title)}</title>\n` +
        `    <updated>${rfc3339(entry.updated)}</updated>\n` +
        `    <link rel="alternate" type="text/html" href="${xmlText(entry.url)}"/>\n` +
        `    <link rel="via" href="${xmlText(entry.citation.url)}"` +
        ` title="${xmlText(entry.citation.label)}"/>\n` +
        `    <summary type="text">${xmlText(entryBody(entry))}</summary>\n` +
        "  </entry>"
      );
    })
    .join("\n");

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<feed xmlns="http://www.w3.org/2005/Atom">\n' +
    `  <id>${xmlText(doc.selfUrl)}</id>\n` +
    `  <title>${xmlText(doc.title)}</title>\n` +
    `  <subtitle>${xmlText(doc.subtitle)}</subtitle>\n` +
    `  <updated>${rfc3339(doc.updated)}</updated>\n` +
    `  <link rel="self" type="application/atom+xml" href="${xmlText(doc.selfUrl)}"/>\n` +
    `  <link rel="alternate" type="text/html" href="${xmlText(doc.homeUrl)}"/>\n` +
    `  <author><name>${xmlText(FEED_AUTHOR)}</name></author>\n` +
    (entries.length === 0 ? "" : `${entries}\n`) +
    "</feed>\n"
  );
}

export function renderRss(doc: FeedDocument): string {
  const items = doc.entries
    .map((entry) => {
      // `isPermaLink="false"` is what makes the guid the URN rather than a URL
      // the reader would otherwise try to fetch. Without the attribute RSS
      // defines the guid as a link, and the whole point of the URN is lost.
      return (
        "    <item>\n" +
        `      <guid isPermaLink="false">${xmlText(entry.urn)}</guid>\n` +
        `      <title>${xmlText(entry.title)}</title>\n` +
        `      <link>${xmlText(entry.url)}</link>\n` +
        `      <pubDate>${rfc822(entry.updated)}</pubDate>\n` +
        `      <description>${xmlText(entryBody(entry))}</description>\n` +
        "    </item>"
      );
    })
    .join("\n");

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n' +
    "  <channel>\n" +
    `    <title>${xmlText(doc.title)}</title>\n` +
    `    <link>${xmlText(doc.homeUrl)}</link>\n` +
    `    <description>${xmlText(doc.subtitle)}</description>\n` +
    `    <lastBuildDate>${rfc822(doc.updated)}</lastBuildDate>\n` +
    `    <atom:link rel="self" type="application/rss+xml" href="${xmlText(doc.selfUrl)}"/>\n` +
    (items.length === 0 ? "" : `${items}\n`) +
    "  </channel>\n" +
    "</rss>\n"
  );
}

/**
 * The title a retraction gets.
 *
 * Prefixed rather than reworded, so a reader skimming subject lines sees the
 * withdrawal in the first word and so the original wording stays recognisable
 * next to the entry it corrects.
 */
export function withdrawnTitle(subject: string): string {
  return `Withdrawn: ${subject}`;
}
