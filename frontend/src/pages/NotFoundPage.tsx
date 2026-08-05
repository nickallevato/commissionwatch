import { Link } from "react-router-dom";

/**
 * The `*` route. Styled to the editorial system rather than the legacy dark
 * palette — `text-gray-100` on paper rendered the headline all but invisible.
 */
export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-xl py-16 text-center sm:py-24">
      <p className="kicker">Error 404</p>
      <h2 className="headline mt-2">Page Not Found</h2>

      <div className="rule-hi mx-auto mt-6 w-16" />

      <p className="mt-6 text-sm leading-relaxed text-muted">
        The page you're looking for doesn't exist.
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
