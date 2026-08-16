import { Link } from "react-router-dom";

/**
 * The heading, exported so no test hardcodes it.
 *
 * When this page was retitled from "Page Not Found" to sentence case on
 * 2026-08-16, **ten assertions across two other files still spelled the old
 * string**, and only four of them failed. The other six were
 * `queryByText("Page Not Found")).toBeNull()` — they kept passing, because the
 * old string was now absent from every page, so they asserted nothing.
 *
 * One of those six was the dead-link detector in `chrome-links.test.tsx`, which
 * walks the site chrome and flags any link landing on this page. It would have
 * gone on reporting zero dead links forever.
 *
 * A renamed string that makes a guard vacuously true is worse than one that
 * breaks it, because nothing tells you. Importing this constant is what makes
 * the rename impossible to half-apply.
 */
export const NOT_FOUND_HEADING = "Page not found";

/**
 * The `*` route. Styled to the editorial system rather than the legacy dark
 * palette — `text-gray-100` on paper rendered the headline all but invisible.
 */
export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-xl py-16 text-center sm:py-24">
      <p className="kicker">Error 404</p>
      <h1 className="headline mt-2">{NOT_FOUND_HEADING}</h1>

      <div className="rule-hi mx-auto mt-6 w-16" />

      <p className="mt-6 text-sm leading-relaxed text-muted">
        The page you&rsquo;re looking for doesn&rsquo;t exist.
      </p>

      <Link
        to="/"
        className="mt-8 inline-block text-[11px] font-semibold uppercase tracking-label text-accent underline underline-offset-4 hover:text-ink"
      >
        Go back home
      </Link>
    </div>
  );
}
