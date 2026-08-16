import { Link, useParams, useSearchParams } from "react-router";
import { Absence } from "@/components/ui/Absence";
import { formatBytes, formatCount, highlightSegments, useSource } from "@/hooks/useSource";
import { formatTimestamp } from "@/lib/dates";

/**
 * `/source/:sha256` — the address every citation on this site points at.
 *
 * Until this page existed, a citation showed its hash as inert text, because
 * linking at a route that does not exist renders the 404 inside the site chrome
 * and reads as a broken record rather than a missing feature. That was tracked
 * by one constant, `SOURCE_VIEWER_EXISTS`, and this page is what flipped it.
 *
 * Three things this page must not get wrong:
 *
 * **The text is untrusted.** It was extracted from third-party PDFs and county
 * HTML. It is rendered as React text nodes and there is no
 * `dangerouslySetInnerHTML` anywhere near it — the same reason
 * `services/search.ts` has `ts_headline` mark matches with control characters
 * instead of `<b>`.
 *
 * **The reader is seeing a slice.** A 2,000-character window presented without
 * saying so is a lie of omission about the document's length, and this is a
 * project that publishes a page about other people's omissions.
 *
 * **A 404 does not say which kind of 404 it is.** Unknown hash, artifact
 * attached to no meeting, and meeting withheld from publication all answer
 * identically, because distinguishing them would let anyone enumerate what has
 * been ingested and not published. See `services/source-viewer.ts`.
 */

/** A parsed non-negative integer from the URL, or 0. Never NaN downstream. */
function readIntParam(raw: string | null): number {
  if (raw === null) return 0;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function SourcePage() {
  const { sha256 } = useParams<{ sha256: string }>();
  const [params] = useSearchParams();
  const offset = readIntParam(params.get("offset"));
  const quoteLength = readIntParam(params.get("len"));

  const { data: source, isLoading, isError } = useSource(sha256, offset);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="headline text-3xl">Source document</h1>
        <p className="mt-4 text-sm text-ink-soft" role="status" aria-live="polite">
          Loading…
        </p>
      </div>
    );
  }

  if (isError || !source) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="headline text-3xl">Source not found</h1>
        <p className="mt-4 max-w-prose text-sm leading-relaxed text-ink-soft">
          No published source has this address.
        </p>
        {/* One sentence covers three states on purpose. Saying which one it was
            would confirm that a document exists and is being withheld. */}
        <Absence reason="request-failed" subject="This document">
          A document is reachable here only once the meeting it belongs to has
          been published.
        </Absence>
        <p className="mt-4 text-sm">
          <Link to="/methodology" className="underline underline-offset-2">
            How citations work
          </Link>
        </p>
      </div>
    );
  }

  const position = offset - source.window_start;
  const segments = highlightSegments(source.text, position, quoteLength);

  return (
    <div className="mx-auto max-w-3xl">
      <header>
        <p className="kicker">Stored document</p>
        <h1 className="headline mt-1.5 text-3xl sm:text-4xl">{source.source_label}</h1>
        <p className="mt-3 max-w-prose text-sm leading-relaxed text-ink-soft">
          This is the file a citation on this site was read from, at the address
          that identifies it. Hash a copy you downloaded yourself and compare —
          the county reorganises its website, and these bytes do not change.
        </p>
      </header>

      <dl className="mt-6 grid grid-cols-1 gap-x-6 gap-y-3 border-y border-rule py-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <dt className="label-sm">Content address (SHA-256)</dt>
          {/* In full, and selectable. An abbreviation is for a citation chip;
              the whole point of this page is that a reader can compare it. */}
          <dd className="mt-0.5 break-all font-mono text-xs">{source.sha256}</dd>
        </div>
        <div>
          <dt className="label-sm">Where we got it</dt>
          <dd className="mt-0.5 break-all text-sm">
            {source.source_url ? (
              <a
                href={source.source_url}
                className="underline underline-offset-2"
                rel="noreferrer"
              >
                {source.source_url}
              </a>
            ) : (
              <span className="text-ink-soft">Not recorded.</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="label-sm">Fetched</dt>
          <dd className="mt-0.5 text-sm figure">
            {source.fetched_at ? (
              formatTimestamp(source.fetched_at)
            ) : (
              <span className="text-ink-soft">Not recorded.</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="label-sm">Size</dt>
          <dd className="mt-0.5 text-sm figure">{formatBytes(source.byte_size)}</dd>
        </div>
        <div>
          <dt className="label-sm">Type</dt>
          <dd className="mt-0.5 text-sm">
            {source.content_type ?? <span className="text-ink-soft">Not recorded.</span>}
          </dd>
        </div>
      </dl>

      <section className="mt-8" aria-labelledby="extract">
        <h2 id="extract" className="font-display text-xl tracking-headline">
          Extracted text
        </h2>

        {source.truncated ? (
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
            You are reading characters{" "}
            <span className="figure">{formatCount(source.window_start)}</span>
            {" to "}
            <span className="figure">{formatCount(source.window_end)}</span>
            {" of "}
            <span className="figure">{formatCount(source.char_count)}</span>. This
            is a window around the quote, not the whole document.
          </p>
        ) : (
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
            This is the whole extracted text of the document —{" "}
            <span className="figure">{formatCount(source.char_count)}</span>{" "}
            characters.
          </p>
        )}

        {segments === null && quoteLength > 0 ? (
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
            The quote this link points at is not inside the text shown. The
            document may have been extracted again since the citation was
            written, which moves every offset in it.
          </p>
        ) : null}

        {source.text === "" ? (
          <Absence reason="absent-upstream" subject="text">
            The file is stored and its bytes are unchanged; nothing readable was
            extracted from them.
          </Absence>
        ) : (
          /* React text nodes, never markup. This text came out of third-party
             PDFs and county HTML, and injecting it as HTML for a typographic
             effect is the exact trade `services/search.ts` refuses to make. */
          <p className="mt-4 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-ink">
            {segments === null ? (
              source.text
            ) : (
              <>
                {segments.before}
                <mark
                  data-testid="cited-quote"
                  className="bg-accent/20 text-ink"
                >
                  {segments.match}
                </mark>
                {segments.after}
              </>
            )}
          </p>
        )}
      </section>
    </div>
  );
}
