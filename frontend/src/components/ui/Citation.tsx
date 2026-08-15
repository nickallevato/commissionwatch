import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { abbreviateSha, sourceHref } from "./citation-source";

/**
 * The furniture around a quotation, in one place.
 *
 * Every surface that shows a claim or a finding must show where it came from,
 * and each was doing it its own way. That is how "no unsourced claim reaches the
 * public site" degrades: not by anyone removing a citation, but by a new surface
 * rendering one slightly less completely than the last.
 *
 * The type is the mechanism. `CitationRef` requires an artifact hash and an
 * offset — the two things that make a quotation checkable — so a component that
 * takes one cannot be handed a decorative source line instead. `minute_claims`
 * enforces the same pair at the database level with NOT NULL on `quote_offset`,
 * and this is that rule reaching the reader.
 */

export interface CitationRef {
  /** SHA-256 of the bytes the quote was read from. The address, not a URL. */
  artifact_sha256: string;
  /** Where the quote was *found* in those bytes. Located, never asserted. */
  quote_offset: number;
  /** The quoted text, verbatim. */
  quote: string;
  /** How a reader should refer to the document: "Minutes, 12 March 2026". */
  source_label: string;
  /** Where we fetched it, shown as "where we got it" rather than as the address. */
  source_url?: string | null;
}

export interface CitationProps {
  citation: CitationRef;
  children?: ReactNode;
}

export function Citation({ citation, children }: CitationProps) {
  const href = sourceHref(citation);

  return (
    <figure className="mt-3 border-l-2 border-rule pl-4">
      {/* The quote is the claim. Everything else on a card is scaffolding
        around a verbatim span of a stored document. */}
      <blockquote className="max-w-prose text-sm leading-relaxed text-ink">
        “{citation.quote}”
      </blockquote>
      <figcaption className="mt-2 text-xs leading-relaxed text-muted">
        {citation.source_label}
        {" · "}
        {href ? (
          /* `Link`, not `<a>`: the source viewer is a route on this site, and a
             bare anchor would reload the whole application to reach it. The
             upstream URL below stays an `<a>` because it leaves. */
          <Link
            to={href}
            title={citation.artifact_sha256}
            className="underline underline-offset-2 hover:text-ink"
          >
            <span className="font-mono">{abbreviateSha(citation.artifact_sha256)}</span>
          </Link>
        ) : (
          <span className="font-mono" title={citation.artifact_sha256}>
            {abbreviateSha(citation.artifact_sha256)}
          </span>
        )}
        {citation.source_url ? (
          <>
            {" · "}
            <a
              href={citation.source_url}
              className="underline underline-offset-2 hover:text-ink"
              rel="noreferrer"
            >
              where we got it
            </a>
          </>
        ) : null}
        {children ? <> {children}</> : null}
      </figcaption>
    </figure>
  );
}

export interface ReviewStampProps {
  /** ISO timestamp of the approval. */
  approved_at: string | null;
  /** Set when the record was withdrawn after publication. */
  retracted_at?: string | null;
}

/**
 * Who let this out, and when.
 *
 * Nothing naming a person auto-publishes; this is the sentence that says a
 * person decided. It deliberately does **not** name the operator — the audit
 * trail records who, and publishing a single maintainer's name beside every
 * finding invites the reader to argue with a person instead of with the record.
 */
export function ReviewStamp({ approved_at, retracted_at }: ReviewStampProps) {
  if (retracted_at) {
    return (
      <p className="mt-2 text-xs text-muted">
        Withdrawn on <span className="figure">{retracted_at.slice(0, 10)}</span>.
      </p>
    );
  }
  if (!approved_at) {
    // Not "approved on —". An unapproved record should not be rendering a
    // review stamp at all, and saying so is more useful than a blank date.
    return (
      <p className="mt-2 text-xs text-muted">Not yet reviewed for publication.</p>
    );
  }
  return (
    <p className="mt-2 text-xs text-muted">
      Approved for publication by an operator on{" "}
      <span className="figure">{approved_at.slice(0, 10)}</span>.
    </p>
  );
}
