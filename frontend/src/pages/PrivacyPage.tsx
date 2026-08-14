import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * `/privacy` — what this site collects, what it does not, and what it deletes.
 *
 * Static, for the same reason `/methodology` is: a page describing how a
 * watchdog behaves must render when the API is down. No fetches, no data
 * dependencies.
 *
 * **Every claim here is checkable against the repository**, and each was
 * verified against the code on the date below rather than described from
 * memory:
 *
 *  - no analytics, tag manager, or error-reporting SDK anywhere in `frontend/`
 *  - no `document.cookie`, `localStorage` or `sessionStorage` in the client at
 *    all — the operator session cookie is `httpOnly` and set server-side in
 *    `backend/src/routes/admin/session.ts`
 *  - `record_disputes` (migration 039) has no IP or user-agent column, and
 *    `backend/src/services/disputes.ts` states the same as a property of the
 *    route rather than as a policy
 *  - donor addresses were dropped by migrations 043 and 051
 *
 * Where the honest answer is "indefinitely, and we have not decided otherwise",
 * this page says that. A privacy page that describes a retention schedule
 * nothing enforces is the same failure as a methodology that drifts from the
 * detectors.
 */

const REVISED = "August 14, 2026";
const VERSION = "1.0";
const CORRECTIONS_EMAIL = "corrections@commissionwatch.bmux.sh";

interface Section {
  readonly id: string;
  readonly title: string;
}

const SECTIONS: readonly Section[] = [
  { id: "readers", title: "If you only read this site" },
  { id: "officials", title: "If you are named in the record" },
  { id: "disputes", title: "If you contest a record" },
  { id: "retention", title: "What is kept, and for how long" },
  { id: "deleted", title: "What we have deliberately deleted" },
  { id: "not-doing", title: "What we do not do" },
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

export function PrivacyPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <header>
        <p className="kicker">How this works</p>
        <h1 className="headline mt-2 text-4xl sm:text-5xl">Privacy and data handling</h1>
        <p className="mt-4 max-w-prose text-base leading-relaxed text-ink-soft">
          This project publishes a public record about people who hold public
          office. That is a strong reason to be careful about everyone else —
          and about how much we keep on the officials themselves beyond what the
          record already says.
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
              We run no analytics and set no cookie on a reader. We store no IP
              address when you contest a record. We have deleted donor home
              addresses from our own database. The only personal information we
              hold that you gave us is a contact you typed into the dispute
              form, and we have not yet set a schedule for deleting it — which
              is stated below rather than papered over.
            </p>
          </div>

          <section className="mt-12" aria-labelledby="readers">
            <p className="label-sm">One</p>
            <SectionHeading id="readers">If you only read this site</SectionHeading>
            <Body>
              We collect nothing about you that identifies you. There is no
              analytics script, no tag manager, no advertising pixel and no
              error-reporting SDK anywhere in the site's code. Nothing is
              written to your browser's local storage, and no cookie is set
              unless you sign in as an operator of this project — a role held by
              its maintainers, not by readers.
            </Body>
            <Body>
              The server keeps ordinary web-server logs, which include IP
              addresses, because a server that logs nothing cannot be defended
              against abuse. They are not joined to anything on this site and
              are not used to build any profile of a reader.
            </Body>
            <Body>
              Search is deliberately unlogged beyond aggregate counts. What
              somebody searches for on a site about their local government is
              nobody's business, including ours.
            </Body>
          </section>

          <section className="mt-12" aria-labelledby="officials">
            <p className="label-sm">Two</p>
            <SectionHeading id="officials">If you are named in the record</SectionHeading>
            <Body>
              What is published about a named person comes from documents a
              government body already published: agendas, minutes, votes and
              filings. Every published statement links to the document it was
              read from, and nothing naming a person is published automatically
              — a person reviews it first.
            </Body>
            <Body>
              We describe the record and not the motive. What is published says
              what happened, when, and in what order. It does not assert intent,
              corruption or illegality, and text that does is rejected before it
              can be approved.
            </Body>
            <Body>
              If something about you is wrong,{" "}
              <Link to="/corrections/dispute" className="underline underline-offset-2">
                contest it
              </Link>
              . You do not need an account and you are not asked to prove who
              you are.
            </Body>
          </section>

          <section className="mt-12" aria-labelledby="disputes">
            <p className="label-sm">Three</p>
            <SectionHeading id="disputes">If you contest a record</SectionHeading>
            <Body>
              The dispute form asks for three things: what you are contesting,
              your account of it, and a way to reach you. That is all that is
              stored. <strong>No IP address and no browser information is
              recorded against a dispute</strong> — there is no column in the
              database to put one in.
            </Body>
            <Body>
              A dispute is never published. There is no public route that can
              read one, and the database constraint permits only the unpublished
              state, so it is enforced in two places rather than promised in
              one.
            </Body>
            <Body>
              A dispute never edits a record by itself. It records what you told
              us; a correction that follows is a separate, deliberate act, and
              the two are linked so the change can be traced back to the reason
              for it.
            </Body>
          </section>

          <section className="mt-12" aria-labelledby="retention">
            <p className="label-sm">Four</p>
            <SectionHeading id="retention">What is kept, and for how long</SectionHeading>
            <Body>
              <strong>The public record is kept permanently.</strong> That is
              the point of the project. Documents are stored by a hash of their
              contents so that a citation still resolves after the source
              website changes, and the history of what this site said is kept so
              that a correction is visible as a change rather than as a
              disappearance.
            </Body>
            <Body>
              <strong>Personal information you gave us has no deletion schedule
              yet.</strong> A contact left on a dispute is currently kept
              indefinitely. That is not a considered retention policy, it is the
              absence of one, and saying so is more useful to you than a
              schedule nothing enforces. If you want your contact removed after
              your dispute is resolved, write to{" "}
              <a className="underline underline-offset-2" href={`mailto:${CORRECTIONS_EMAIL}`}>
                {CORRECTIONS_EMAIL}
              </a>{" "}
              and we will remove it.
            </Body>
          </section>

          <section className="mt-12" aria-labelledby="deleted">
            <p className="label-sm">Five</p>
            <SectionHeading id="deleted">What we have deliberately deleted</SectionHeading>
            <Body>
              Campaign finance filings are public and they contain the home
              addresses of individual donors. We ingested them, decided that
              republishing a private individual's address served no
              accountability purpose, and{" "}
              <strong>removed the address columns from the database entirely</strong>{" "}
              — not hidden from the interface, dropped from storage. The
              aggregate contribution data that supports the analysis remains.
            </Body>
            <Body>
              The rule that came out of it governs new work: this project maps
              and publishes <em>decisions</em>, not people's private lives. A
              record about where an official lives is not a record of what they
              did in office.
            </Body>
          </section>

          <section className="mt-12" aria-labelledby="not-doing">
            <p className="label-sm">Six</p>
            <SectionHeading id="not-doing">What we do not do</SectionHeading>
            <Body>
              We do not sell, rent or share data about readers, because we do
              not have any. We do not run advertising. We do not use a
              third-party service that would receive your requests on our behalf
              while you browse. We do not build profiles of private individuals,
              and we do not accept detectors that single out one category of
              organisation — the same logic applies to every entity, which is
              what makes a finding defensible.
            </Body>
            <Body>
              We do not attempt to identify speakers from audio. Where a
              recording is transcribed, the transcript is labelled as a machine
              transcript and is never used as the source for a statement about
              what a named person said.
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
