import { useState } from "react";
import { Outlet, NavLink, Link } from "react-router-dom";

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
  { to: "/anomalies", label: "Findings" },
  { to: "/meetings", label: "Meetings" },
  { to: "/members", label: "Officials" },
  { to: "/votes", label: "Votes" },
  { to: "/methodology", label: "Methodology" },
  { to: "/subscribe", label: "Alerts" },
];

const JURISDICTIONS = "Bozeman, MT · Gallatin County";
const LAST_SWEEP = "Last sweep 12 min ago";

/** Shared measure. Generous gutters; a max width that keeps lines readable. */
const shell = "mx-auto w-full max-w-6xl px-6 sm:px-10 lg:px-14";

/** The one focus treatment. Visible, accent, offset off the hairlines. */
const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export function Layout() {
  const [menuOpen, setMenuOpen] = useState(false);

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
              {LAST_SWEEP}
            </span>
          </div>
        </div>
      </header>

      <main id="main" className={`${shell} flex-1 py-10 sm:py-14`}>
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
              to="/data-license"
              className={`text-[11px] font-semibold uppercase tracking-label text-muted hover:text-ink ${focusRing}`}
            >
              Data License
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
