import type { Knex } from "knex";
import { whereMeetingPublished } from "./publication";

/**
 * A stored document, at its content address, for a reader checking a citation.
 *
 * Every claim this project publishes points at `sha256` + `quote_offset`, and
 * until now there was nothing at the other end of that pointer. A citation
 * nobody can open is a citation nobody can check, which makes it decoration.
 *
 * **The address is the hash, not a URL.** The county reorganises its site; the
 * bytes do not change. A reader can also hash a file they downloaded themselves
 * and compare — which is the strongest form of "check our work" available here,
 * and it costs us nothing to offer.
 *
 * ## The wall
 *
 * The path to it is the one `services/search.ts` already walks:
 * `artifact_texts → document_versions → meeting_documents → meetings`, then
 * `whereMeetingPublished`. That join is why a document belonging to an
 * unpublished meeting is unreachable here, and it is reached through the same
 * helper rather than a retyped predicate.
 *
 * An artifact with no `document_versions` row — a campaign-finance filing, an
 * orphan — is **not** served. It has no meeting to be published, so there is no
 * rule under which it becomes public, and defaulting to visible is how a bulk
 * endpoint leaks. `undefined` covers "no such artifact", "not attached to a
 * meeting" and "its meeting is withheld", and the route turns all three into the
 * same 404, for the reason `findPublishedMeeting` gives.
 */

/** Enough context to read around a quote without shipping a whole PDF. */
export const WINDOW_CHARS = 2_000;

export interface SourceWindow {
  sha256: string;
  content_type: string | null;
  byte_size: number;
  /** Where we fetched it. Shown as provenance, never as the address. */
  source_url: string | null;
  fetched_at: string | null;
  char_count: number;
  /** The slice of text returned, and where in the document it starts. */
  text: string;
  window_start: number;
  window_end: number;
  /** True when the document is longer than what was returned. */
  truncated: boolean;
  /** How a reader should refer to it: "Minutes, 12 March 2026". */
  source_label: string;
}

interface Row {
  sha256: string;
  content_type: string | null;
  byte_size: number;
  source_url: string | null;
  fetched_at: Date | string | null;
  text: string;
  char_count: number;
  document_title: string | null;
  document_type: string | null;
  meeting_date: Date | string | null;
  commission_name: string | null;
}

function isoDate(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function labelFor(row: Row): string {
  const parts: string[] = [];
  if (row.document_title) parts.push(row.document_title);
  else if (row.document_type) parts.push(row.document_type);
  if (row.commission_name) parts.push(row.commission_name);
  const date = isoDate(row.meeting_date);
  if (date) parts.push(date.slice(0, 10));
  return parts.join(", ") || "Stored document";
}

/**
 * The document window around `offset`, or `undefined`.
 *
 * `offset` is clamped rather than validated into an error: a citation whose
 * offset has drifted past the end of a re-extracted document should still open
 * the document. Showing the reader the wrong part of the right file is a much
 * better failure than a 404 that reads as "we made this up".
 */
export async function readSourceWindow(
  db: Knex,
  sha256: string,
  offset = 0,
): Promise<SourceWindow | undefined> {
  const row: unknown = await whereMeetingPublished(
    db("artifacts as a")
      .join("artifact_texts as at", "at.artifact_id", "a.id")
      .join("document_versions as dv", "dv.artifact_id", "a.id")
      .join("meeting_documents as md", "md.id", "dv.meeting_document_id")
      .join("meetings as m", "m.id", "md.meeting_id")
      .join("commissions as c", "c.id", "m.commission_id"),
    "m.published_at",
  )
    .where("a.sha256", sha256)
    .first(
      "a.sha256",
      "a.content_type",
      "a.byte_size",
      "a.source_url",
      "a.fetched_at",
      "at.text",
      "at.char_count",
      "md.title as document_title",
      "md.document_type",
      "m.date as meeting_date",
      "c.name as commission_name",
    );

  if (typeof row !== "object" || row === null) return undefined;
  const record = row as Row;

  const length = record.text.length;
  const anchor = Math.max(0, Math.min(offset, length));
  const start = Math.max(0, anchor - Math.floor(WINDOW_CHARS / 2));
  const end = Math.min(length, start + WINDOW_CHARS);

  return {
    sha256: record.sha256,
    content_type: record.content_type,
    byte_size: Number(record.byte_size),
    source_url: record.source_url,
    fetched_at: isoDate(record.fetched_at),
    char_count: Number(record.char_count),
    text: record.text.slice(start, end),
    window_start: start,
    window_end: end,
    truncated: start > 0 || end < length,
    source_label: labelFor(record),
  };
}
