import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/useAuth";
import { ACTION_QUIET, FOCUS_RING } from "./PressroomUI";
import type { PressroomSource } from "@/types";

/**
 * The console's own shell.
 *
 * Until now every admin route rendered inside the **public** `Layout`, so an
 * operator checking whether the scrapers ran was looking at a newspaper
 * masthead and a reader's nav — Findings, Meetings, Officials, Votes, Search,
 * Methodology, Alerts — not one of which is any use backstage. There was no
 * `<nav>` anywhere in the admin at all, which is why `AdminHomePage` existed:
 * a link list standing in for navigation that had never been built.
 *
 * This is that navigation. Sunk ground, a brand block, and a persistent rail
 * grouped by the job you came to do rather than by the table the data sits in.
 *
 * Three things about the rail are deliberate:
 *
 * **It is a real `<nav>` with real lists.** Group headings are headings and
 * links are list items, so the whole console is navigable by landmark and by
 * list without seeing any of it.
 *
 * **Active state is never colour alone.** The current page carries an accent
 * left border, semibold ink on paper, *and* `aria-current="page"`. Any one of
 * those three failing still leaves two.
 *
 * **A destination with no route is not a link.** The mockup's rail lists
 * surfaces this product has not built. Rendering them as dead links would be
 * worse than saying plainly where they are reached from, so they render as
 * greyed text carrying their reason — the same choice `AdminHomePage` made for
 * the run and meeting screens, which are reached from a record and not from a
 * menu.
 */

interface RailItem {
  readonly label: string;
  /** `null` for a surface with no route. It renders as text, never as a link. */
  readonly to: string | null;
  /** Why it is not a link. Required whenever `to` is null. */
  readonly note?: string;
  /** `true` for the "Later" group — present as a commitment, not yet real. */
  readonly later?: boolean;
  /** Shows the failing-source count. Only Sources carries one. */
  readonly pip?: "sources";
}

interface RailGroup {
  readonly name: string;
  readonly items: readonly RailItem[];
}

const RAIL: readonly RailGroup[] = [
  {
    name: "Operate",
    items: [
      { label: "Dashboard", to: "/admin" },
      { label: "Sources", to: "/admin/sources", pip: "sources" },
      {
        label: "Runs",
        to: null,
        note: "A run is reached from its source row — there is no list of every run ever.",
      },
      { label: "Queue", to: "/admin/review" },
      // A second queue rather than a tab of the first: a finding is an
      // inference about a pattern and a claim is a quotation of the minutes,
      // and the evidence an operator needs to decide them is not the same
      // evidence.
      { label: "Claims", to: "/admin/claims" },
      // A third queue for the same reason there is a second: a place link is
      // not a sentence about a person, it is an assertion about where a
      // decision happened, and what an operator must read to decide one is a
      // coordinate and its precision rather than a rendered sentence.
      { label: "Place links", to: "/admin/place-links" },
      // Under Operate rather than beside the queues: nothing here is reviewed
      // and no row here names a person. It is the switch panel — what is
      // running, what decided it, and the one place to change it without a
      // redeploy. Nothing it can write gates a wall.
      { label: "Features", to: "/admin/features" },
    ],
  },
  {
    name: "Record",
    items: [
      {
        label: "Meetings",
        to: null,
        note: "A meeting record is reached from the run that ingested it.",
      },
      {
        label: "Officials",
        to: null,
        note: "Officials are published from the seed data and have no operator surface yet.",
      },
      // Not a queue and deliberately not beside them: nothing on this screen is
      // decided and nothing on it writes a row. It reports which body's roster
      // is unsourced and which names the record prints that the roster does not
      // account for — the gap that makes the claim verifier discard true claims.
      { label: "Roster", to: "/admin/roster" },
      { label: "Requests", to: "/admin/records" },
    ],
  },
  {
    name: "Deliver",
    items: [
      { label: "Channels", to: "/admin/channels" },
      {
        label: "Subscribers",
        to: null,
        note: "A reader's subscription is their personal data, reachable only by their own token.",
      },
    ],
  },
  {
    name: "Later",
    items: [
      { label: "Corrections", to: null, later: true, note: "Corrections are recorded on the meeting they correct." },
      { label: "Votes", to: null, later: true, note: "No vote has been ingested yet." },
      { label: "Artifacts", to: null, later: true, note: "Artifacts are listed on the record they back." },
    ],
  },
];

/** The verdicts that mean a source is not doing its job. */
const FAILING: ReadonlySet<PressroomSource["verdict"]> = new Set([
  "never_run",
  "failing",
  "suspect",
]);

const RAIL_LINK =
  "flex items-center justify-between gap-2 border-l-2 px-4 py-1.5 text-[12.5px] no-underline";

export function PressroomLayout() {
  const { operator, signOut } = useAuth();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);
  const [failing, setFailing] = useState<number | null>(null);

  /**
   * The failure pip.
   *
   * Fetched once per shell mount and allowed to fail in silence: a console
   * whose navigation explodes because a count could not be read is worse than
   * a console with no count, and the Sources screen itself is the authority
   * either way. `null` renders no pip rather than a zero we do not know.
   */
  useEffect(() => {
    let ignore = false;
    void (async () => {
      try {
        const res = await fetch("/api/admin/pressroom/sources", { credentials: "same-origin" });
        if (!res.ok) return;
        const body = (await res.json()) as { data: PressroomSource[] };
        if (ignore) return;
        setFailing(body.data.filter((source) => FAILING.has(source.verdict)).length);
      } catch {
        // Deliberately silent. See above.
      }
    })();
    return () => {
      ignore = true;
    };
  }, []);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
      navigate("/admin/login", { replace: true });
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="min-h-screen bg-paper-sunk text-ink">
      <a
        href="#pressroom-work"
        className={`sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:border focus:border-ink focus:bg-paper focus:px-3 focus:py-2 focus:text-xs focus:font-semibold focus:uppercase focus:tracking-label focus:text-ink ${FOCUS_RING}`}
      >
        Skip to the work
      </a>

      <div className="mx-auto flex w-full max-w-[1400px] flex-col md:flex-row">
        {/* The rail stacks above the work area on a phone rather than
            collapsing behind a button. It is the only navigation the console
            has; hiding it behind a toggle would put every screen one
            undiscoverable tap from every other. */}
        <aside className="flex w-full flex-none flex-col gap-5 border-b border-rule bg-paper-sunk py-4 md:min-h-screen md:w-[188px] md:border-b-0 md:border-r md:py-5">
          <div className="px-4">
            <Link to="/admin" className={`block no-underline ${FOCUS_RING}`}>
              <span className="block font-display text-[17px] font-semibold tracking-headline text-ink">
                CommissionWatch
              </span>
              <span className="block text-[10px] font-bold uppercase tracking-label text-accent">
                Pressroom
              </span>
            </Link>
          </div>

          <nav aria-label="Pressroom" className="flex flex-col">
            {RAIL.map((group) => (
              <div key={group.name}>
                <h2 className="px-4 pb-1 pt-3.5 text-[10px] font-semibold uppercase tracking-label text-muted">
                  {group.name}
                </h2>
                <ul className="flex flex-col">
                  {group.items.map((item) => (
                    <li key={item.label}>
                      {item.to === null ? (
                        <span
                          data-testid={`rail-${item.label.toLowerCase()}`}
                          className={`${RAIL_LINK} border-transparent text-muted ${
                            item.later ? "opacity-50" : ""
                          }`}
                          title={item.note}
                        >
                          {item.label}
                          <span className="sr-only"> — not a destination. {item.note}</span>
                        </span>
                      ) : (
                        <NavLink
                          to={item.to}
                          end={item.to === "/admin"}
                          data-testid={`rail-${item.label.toLowerCase()}`}
                          className={({ isActive }) =>
                            `${RAIL_LINK} ${FOCUS_RING} ${
                              isActive
                                ? "border-accent bg-paper font-semibold text-ink"
                                : "border-transparent text-ink-soft hover:text-ink"
                            }`
                          }
                        >
                          {({ isActive }) => (
                            <>
                              <span>{item.label}</span>
                              {isActive && <span className="sr-only"> (current page)</span>}
                              {item.pip === "sources" && failing !== null && failing > 0 && (
                                <span
                                  data-testid="rail-pip"
                                  className="border border-current px-1 font-mono text-[10px] font-bold text-accent tabular"
                                >
                                  {failing}
                                  <span className="sr-only">
                                    {" "}
                                    source{failing === 1 ? "" : "s"} not collecting
                                  </span>
                                </span>
                              )}
                            </>
                          )}
                        </NavLink>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>

          <div className="mt-auto border-t border-rule px-4 pt-3 text-[11px] text-muted">
            <p>Signed in as</p>
            {/* Truncate rather than wrap. The rail is a fixed narrow column and
                an address like operator@commissionwatch.bmux.sh breaks across three
                lines under `break-all`, shoving the sign-out button around and
                making the rail's height depend on who is signed in. The full
                value stays reachable as a tooltip and to assistive tech. */}
            <p
              className="truncate font-mono text-[10.5px] font-bold text-ink-soft"
              title={operator ? operator.email : undefined}
            >
              {operator ? operator.email : "unknown"}
            </p>
            <button
              type="button"
              onClick={() => void handleSignOut()}
              disabled={signingOut}
              className={`mt-2.5 ${ACTION_QUIET} ${FOCUS_RING}`}
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </aside>

        <main
          id="pressroom-work"
          className="flex min-w-0 flex-1 flex-col gap-5 bg-paper px-5 py-5 sm:px-6 sm:py-6"
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/**
 * The sign-in ground.
 *
 * Screen 01 has a masthead of its own and no rail: an operator who is not
 * signed in cannot use a single link on it, and the public masthead would
 * offer a reader's nav to somebody trying to get backstage. So the login route
 * gets the sunk ground and nothing else.
 */
export function PressroomAuthLayout() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-5 py-10 text-ink">
      <div className="w-full max-w-[352px]">
        <Outlet />
      </div>
    </div>
  );
}
