import type { ReactNode } from "react";
import { Link } from "react-router";

/**
 * `/accessibility` — the conformance target this site measures itself
 * against, what actually checks it, and what that checking has found.
 *
 * Static, for the same reason `/privacy` and `/methodology` are: a page
 * describing how the site is built must render even when the API is down.
 *
 * A stated conformance target that nobody publishes is a private intention,
 * not a commitment. This page exists because WCAG 2.2 AA was already a real
 * target — `src/a11y.test.tsx` already runs axe-core over the public routes
 * and, as of this revision, the operator console's review screens too — and
 * contrast ratios were already computed rather than eyeballed — but none of
 * that was said anywhere a reader could find it. Checked against the code on
 * the date below rather than described from memory.
 */

const REVISED = "August 16, 2026";
const VERSION = "1.0";
const CORRECTIONS_EMAIL = "corrections@commissionwatch.bmux.sh";

interface Section {
  readonly id: string;
  readonly title: string;
}

const SECTIONS: readonly Section[] = [
  { id: "target", title: "The conformance target" },
  { id: "tested", title: "What is actually tested" },
  { id: "limitations", title: "Known limitations" },
  { id: "report", title: "Report a problem" },
  { id: "language", title: "Why this site is English-only" },
];

function SectionHeading({ id, children }: { id: string; children: string }) {
  return (
    <>
      <h2
        id={id}
        className="scroll-mt-8 font-display text-2xl tracking-headline sm:text-[1.75rem]"
      >
        {children}
      </h2>
      <hr className="mt-3 rule-hi" />
    </>
  );
}

function Body({ children }: { children: ReactNode }) {
  return (
    <p className="mt-4 max-w-prose text-[0.9375rem] leading-relaxed text-ink-soft">
      {children}
    </p>
  );
}

export function AccessibilityPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <header>
        <p className="kicker">How this works</p>
        <h1 className="headline mt-2 text-4xl sm:text-5xl">Accessibility</h1>
        <p className="mt-4 max-w-prose text-base leading-relaxed text-ink-soft">
          What this site aims for, what actually checks that, and where the
          checking has found it short. A watchdog project that will not state
          its own known defects has no standing to publish anyone else&rsquo;s.
        </p>
        <p className="mt-4 text-xs text-muted">
          Version <span className="figure">{VERSION}</span>
          {" · "}
          Revised <span className="figure">{REVISED}</span>
        </p>
      </header>

      <div className="mt-10 lg:grid lg:grid-cols-[minmax(0,1fr)_13rem] lg:gap-12">
        <article className="border-t border-rule pt-8">
          <div className="border-l-2 border-accent pl-4">
            <p className="label-sm">The short version</p>
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
              The target is WCAG 2.2 AA, measured by an automated scan on
              every public route and on the operator console&rsquo;s own
              review screens in continuous integration, not held as a
              certification. One known failure is stated below rather than
              fixed quietly and forgotten: two severity colours in the light
              theme do not clear AA contrast for normal text on their own, and
              the reason that still meets the standard is also stated.
            </p>
          </div>

          <section className="mt-12" aria-labelledby="target">
            <p className="label-sm">One</p>
            <SectionHeading id="target">The conformance target</SectionHeading>
            <Body>
              This site targets{" "}
              <strong className="font-semibold text-ink">
                WCAG 2.2 at Level AA
              </strong>
              . That is a target the project measures against itself, not a
              certification issued by anyone else — no third party has audited
              this site, and this page is not a claim that one has.
            </Body>
            <Body>
              A target is only worth stating if a reader can check whether it
              is being met, which is what the rest of this page is for: the
              mechanism, and what it has found.
            </Body>
          </section>

          <section className="mt-12" aria-labelledby="tested">
            <p className="label-sm">Two</p>
            <SectionHeading id="tested">What is actually tested</SectionHeading>
            <Body>
              Every public route on this site is rendered inside the real site
              chrome and scanned with{" "}
              <strong className="font-semibold text-ink">axe-core</strong>, the
              same accessibility-rule engine used across the industry, as part
              of the automated test suite that runs before any change reaches
              production. The scan lives in the codebase at{" "}
              <code className="font-mono text-sm">src/a11y.test.tsx</code>; a
              route that fails it fails the build.
            </Body>
            <Body>
              That suite also checks that moving between pages sends a screen
              reader&rsquo;s focus to the new page&rsquo;s heading, and that a
              heading a reader lands on that way is never left reachable by
              tabbing past it a second time.
            </Body>
            <Body>
              Colour contrast is checked separately from that automated scan.
              The test environment the route scan runs in has no rendering
              engine that can sample actual pixels, so axe&rsquo;s own
              contrast rule cannot execute there and is turned off for that
              reason alone, not because the project prefers not to know the
              answer. Instead, every text colour this site uses is{" "}
              <strong className="font-semibold text-ink">
                computed against the page backgrounds it appears on, by WCAG
                relative luminance, rather than judged by eye
              </strong>
              . That is how the limitation below was found in the first
              place: a computed number, not a guess.
            </Body>
            <Body>
              The automated scan covers the public site — everything reachable
              without signing in — and, separately, the screens of the
              operator console behind the login wall that a reviewer actually
              works from: the dashboard, the ingestion sources board, and the
              two decision queues from which a generated finding or a quoted
              claim about a named person becomes public. That second sweep
              renders the console&rsquo;s own chrome and a signed-in session,
              the same way the public scan renders the reader&rsquo;s
              masthead, and it also checks something axe cannot: that the
              approve and reject controls on the claim queue, and its
              collapsible per-subject groups, are reachable and operable by
              keyboard alone, not only by a mouse. It does not yet cover every
              admin screen — only the ones a reviewer&rsquo;s work runs
              through.
            </Body>
          </section>

          <section className="mt-12" aria-labelledby="limitations">
            <p className="label-sm">Three</p>
            <SectionHeading id="limitations">Known limitations</SectionHeading>
            <Body>
              <strong className="font-semibold text-ink">
                Two severity colours fail AA contrast for normal text in the
                light theme.
              </strong>{" "}
              The amber used for a medium-severity flag measures{" "}
              <span className="figure">3.08:1</span> against the page
              background, and the grey used for a low-severity flag measures{" "}
              <span className="figure">3.61:1</span>. Both clear the lower bar
              for large text only — not the 4.5:1 the standard requires for
              body-sized text. Neither colour is used to set body text; both
              are used as a solid fill behind a numeral.
            </Body>
            <Body>
              This is mitigated, not silently accepted:{" "}
              <strong className="font-semibold text-ink">
                severity is never carried by colour alone.
              </strong>{" "}
              The component that renders a severity square (
              <code className="font-mono text-sm">SeverityMark</code>) always
              prints the severity&rsquo;s numeral rank inside the fill and
              carries a screen-reader-only label naming the severity in words
              — &ldquo;Severity 2 of 5, low&rdquo; — alongside a visible{" "}
              <code className="font-mono text-sm">title</code> attribute. A
              reader who cannot distinguish the fill colour, or who cannot see
              colour at all, still gets the same information every sighted
              reader gets. The colour reinforces the numeral; it does not
              replace it.
            </Body>
            <Body>
              The automated route scan covers the public site and the
              operator console&rsquo;s own review screens — dashboard,
              sources, the finding queue, the claim queue — but not every
              screen behind the login wall. A console page outside that set
              has not been checked by this suite, even though it is an
              internal tool rather than the surface this project asks a
              reader to trust.
            </Body>
          </section>

          <section className="mt-12" aria-labelledby="report">
            <p className="label-sm">Four</p>
            <SectionHeading id="report">Report a problem</SectionHeading>
            <Body>
              If something on this site is hard or impossible to use with a
              keyboard, a screen reader, magnification, or any other
              assistive technology, say so at{" "}
              <a
                className="underline underline-offset-2"
                href={`mailto:${CORRECTIONS_EMAIL}`}
              >
                {CORRECTIONS_EMAIL}
              </a>
              . Say which page, what you were trying to do, and what happened
              instead.
            </Body>
            <Body>
              This goes to the same address as every other correction, and
              deliberately not through{" "}
              <Link to="/corrections/dispute" className="underline underline-offset-2">
                the dispute form
              </Link>
              : that form contests the content of a specific published
              record — a meeting, an agenda item, a document, a finding — and
              asks for the record&rsquo;s address before it will accept
              anything. An accessibility barrier is not a claim about a
              record; it is a claim about the site itself, and forcing it
              through a form built to point at a database row would be the
              wrong tool wearing the right name.
            </Body>
          </section>

          <section className="mt-12" aria-labelledby="language">
            <p className="label-sm">Five</p>
            <SectionHeading id="language">
              Why this site is English-only
            </SectionHeading>
            <Body>
              <strong className="font-semibold text-ink">
                This site is published in English only, and it will stay that
                way.
              </strong>{" "}
              The underlying record — agendas, minutes, resolutions, vote
              tallies — is itself published in English by the city and county
              custodians who produce it. Every claim on this site traces back
              to one of those documents by a stored citation. A translation of
              that record produced by this project would trace back to
              nothing but this project&rsquo;s own rendering of it — an
              unsourced derivative of exactly the kind this site refuses to
              publish about anything else.
            </Body>
            <Body>
              Two routes exist instead, and each is honest about what it does
              and does not do. The{" "}
              <Link className="cite" to="/data">
                open-data export
              </Link>{" "}
              carries the same structured record this site reads from, so
              anyone may translate it themselves and say, in their own name,
              who did the translating. And{" "}
              <Link className="cite" to="/public-records">
                requesting a record
              </Link>{" "}
              obtains the underlying document directly from the government
              body that produced it, rather than through this project at all.
            </Body>
            <Body>
              What this page will not do is promise a translation this
              project has no mechanism to produce and no plan to build. A
              limitation stated plainly is more useful than a feature implied
              and never delivered.
            </Body>
          </section>

          <p className="mt-12 max-w-prose text-sm leading-relaxed text-ink-soft">
            If this page and the code ever disagree, the code is what is true
            and this page is the bug. Tell us at{" "}
            <a className="underline underline-offset-2" href={`mailto:${CORRECTIONS_EMAIL}`}>
              {CORRECTIONS_EMAIL}
            </a>
            .
          </p>
        </article>

        <nav aria-label="On this page" className="mt-12 lg:mt-0">
          <p className="label-sm">On this page</p>
          <ul className="mt-3 space-y-2">
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="text-sm leading-snug text-ink-soft underline-offset-2 hover:underline"
                >
                  {section.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </div>
  );
}
