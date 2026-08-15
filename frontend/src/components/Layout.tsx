import { useRef, useState } from "react";
import { Outlet, NavLink, Link } from "react-router-dom";
import {
  formatSweepAge,
  useIngestionStatus,
} from "@/hooks/useIngestionStatus";
import { useRouteFocus } from "@/hooks/useRouteFocus";

/**
 * The app shell: a newspaper masthead, a strap line, the copy well, a colophon.
 *
 * There is one <nav> element for the primary links, not two. On small screens
 * it is collapsed behind the menu button and wraps onto its own row when
 * opened; on md+ it sits inline to the right of the wordmark. Keeping a single
 * list means the accessibility tree never carries duplicate links.
 */

interface NavItem {
  to: string;
  label: string;
}

const navItems: NavItem[] = [
  { to: "/findings", label: "Findings" },
  { to: "/meetings", label: "Meetings" },
  // The same record read the other way: meetings are when the body sat,
  // matters are what it is deciding. Next to Meetings rather than at the end
  // because a reader who wants one usually wants to know the other exists.
  { to: "/matters", label: "Matters" },
  { to: "/officials", label: "Officials" },
  { to: "/votes", label: "Votes" },
  // Scaffolded, and the page says so rather than showing placeholder
  // candidates. It sits in the masthead so the module has a home to build
  // into; it publishes nothing until it can cite a filing.
  { to: "/elections", label: "Elections" },
  // P6. Search sits with the record it searches, not in the utility row: the
  // archive is the product, and a reader arriving with a question starts here.
  { to: "/search", label: "Search" },
  // The record by location. Labelled "Nearby" rather than "Map" because the
  // page is not a slippy map and cannot become one under this site's content
  // policy — a nav item promising a map would be the same overclaim the page
  // itself refuses to make about a block-level geocode.
  { to: "/map", label: "Nearby" },
  // When these bodies sit. In the masthead rather than the colophon because a
  // reader who wants to attend a meeting is looking for the record, not for an
  // account of how the site works.
  { to: "/calendar", label: "Calendar" },
  { to: "/methodology", label: "Methodology" },
  { to: "/subscribe", label: "Alerts" },
];

const JURISDICTIONS = "Bozeman, MT · Gallatin County";

/** Shared measure. Generous gutters; a max width that keeps lines readable. */
const shell = "mx-auto w-full max-w-6xl px-6 sm:px-10 lg:px-14";

/** The one focus treatment. Visible, accent, offset off the hairlines. */
const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export function Layout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  useRouteFocus(mainRef);
  // The masthead used to assert "Last sweep 12 min ago" from a constant. Real
  // records now exist, so a made-up age is a false statement on a transparency
  // site rather than a placeholder. `data` is undefined while the request is in
  // flight and when it fails, and both read as "No sweep yet" — the site says it
  // does not know instead of guessing.
  const { data: ingestion } = useIngestionStatus();
  const lastSweep = formatSweepAge(ingestion?.lastSuccessfulSweepAt);

  return (
    <div className="min-h-screen bg-paper text-ink flex flex-col">
      <a
        href="#main"
        className={`sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:bg-paper focus:px-3 focus:py-2 focus:text-xs focus:font-semibold focus:uppercase focus:tracking-label focus:text-ink focus:border focus:border-ink ${focusRing}`}
      >
        Skip to content
      </a>

      <header>
        <div className={shell}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-4 pt-7 pb-4 sm:pt-9 sm:pb-5">
            <Link
              to="/"
              className={`font-display text-3xl sm:text-4xl font-semibold leading-headline tracking-headline text-ink ${focusRing}`}
            >
              CommissionWatch
            </Link>

            <button
              type="button"
              aria-expanded={menuOpen}
              aria-controls="primary-navigation"
              onClick={() => setMenuOpen((open) => !open)}
              className={`md:hidden inline-flex items-center gap-2 border border-rule px-3 py-1.5 text-[11px] font-semibold uppercase tracking-label text-muted hover:border-ink hover:text-ink ${focusRing}`}
            >
              <MenuGlyph open={menuOpen} />
              Menu
            </button>

            <nav
              id="primary-navigation"
              aria-label="Primary"
              className={`${
                menuOpen ? "flex" : "hidden"
              } md:flex order-last md:order-none w-full md:w-auto flex-col md:flex-row items-start md:items-baseline gap-x-7 gap-y-1 pb-2 md:pb-0`}
            >
              {navItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  onClick={() => setMenuOpen(false)}
                  className={({ isActive }) =>
                    `border-b-2 py-1 text-[11px] font-semibold uppercase tracking-label ${focusRing} ${
                      isActive
                        ? "border-accent text-ink"
                        : "border-transparent text-muted hover:text-ink"
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>

          <div className="rule-hi-strong" role="presentation" />

          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-b border-rule py-2">
            <span className="label-sm">{JURISDICTIONS}</span>
            <span className="label-sm tabular inline-flex items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-block h-1.5 w-1.5 rounded-full bg-accent"
              />
              {lastSweep}
            </span>
          </div>
        </div>
      </header>

      {/* tabIndex -1 serves both jobs: it is the fallback target for
        `useRouteFocus`, and it is what makes the "Skip to content" link above
        actually move focus rather than only scroll — a bare `href="#main"`
        pointing at a non-focusable element leaves the tab order in the
        masthead in every browser that follows the spec here. */}
      <main
        id="main"
        ref={mainRef}
        tabIndex={-1}
        className={`${shell} flex-1 py-10 sm:py-14 focus:outline-none`}
      >
        <Outlet />
      </main>

      <footer className="mt-16 border-t border-rule">
        <div
          className={`${shell} flex flex-col gap-4 py-8 sm:flex-row sm:items-baseline sm:justify-between`}
        >
          <p className="max-w-prose text-xs leading-relaxed text-muted">
            An independent watchdog project. Not affiliated with any government
            agency.
          </p>
          <nav
            aria-label="Footer"
            className="flex flex-wrap items-baseline gap-x-6 gap-y-2"
          >
            <Link
              to="/methodology"
              className={`text-[11px] font-semibold uppercase tracking-label text-muted hover:text-ink ${focusRing}`}
            >
              Methodology
            </Link>
            <Link
              to="/public-records"
              className={`text-[11px] font-semibold uppercase tracking-label text-muted hover:text-ink ${focusRing}`}
            >
              Request a record
            </Link>
            {/* The colophon, not the masthead nav. `/status` is an account of
              this site's own collection rather than a part of the record, and
              it belongs beside the methodology and the licence for the same
              reason those do. */}
            <Link
              to="/status"
              className={`text-[11px] font-semibold uppercase tracking-label text-muted hover:text-ink ${focusRing}`}
            >
              Collection status
            </Link>
            {/* B3. The corrections policy belongs beside the methodology for
              the same reason the methodology is here at all: it is the account
              of how this site behaves, and it has to be reachable from every
              page rather than from the one a reader happens to be on when
              they find something wrong. */}
            <Link
              to="/metrics"
              className={`text-[11px] font-semibold uppercase tracking-label text-muted hover:text-ink ${focusRing}`}
            >
              By the numbers
            </Link>
            <Link
              to="/corrections"
              className={`text-[11px] font-semibold uppercase tracking-label text-muted hover:text-ink ${focusRing}`}
            >
              Corrections
            </Link>
            <Link
              to="/data"
              className={`text-[11px] font-semibold uppercase tracking-label text-muted hover:text-ink ${focusRing}`}
            >
              Open data
            </Link>
            {/* The colophon again, and for a reason worth stating: a site that
              publishes people's names owes a reachable account of what it holds
              about everyone else. It sits beside the methodology because it is
              the same kind of document — how this site behaves, not part of the
              record. */}
            <Link
              to="/privacy"
              className={`text-[11px] font-semibold uppercase tracking-label text-muted hover:text-ink ${focusRing}`}
            >
              Privacy
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}

function MenuGlyph({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
    >
      {open ? (
        <path d="M5 5l14 14M19 5L5 19" />
      ) : (
        <path d="M3.5 7h17M3.5 12h17M3.5 17h17" />
      )}
    </svg>
  );
}
