import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * `/bot` — the page for machines, written for the person who sent one.
 *
 * `robots.txt` names retrieval crawlers separately from training crawlers and
 * invites both in. An invitation should say what is inside, and until now this
 * project's machine-readable surfaces were discoverable only by reading the
 * source or guessing a path.
 *
 * Static, like `/methodology` and `/privacy`: it must render when the API is
 * down, which is exactly when somebody is most likely to be checking whether we
 * have an endpoint they can rely on.
 *
 * Every path below is asserted by `BotPage.test.tsx` against the routes and
 * exports that actually exist. A page for machines that lists an endpoint we do
 * not serve is worse than no page — it is a 404 published on our behalf.
 */

const BASE = "https://commissionwatch.bmux.sh";

interface Surface {
  readonly path: string;
  readonly what: string;
  readonly note?: string;
}

/** Bulk and structured reads. Everything here is public and unauthenticated. */
const MACHINE_SURFACES: readonly Surface[] = [
  {
    path: "/api/data",
    what: "Manifest of every bulk export, with row counts and column lists.",
    note: "Start here. It describes the files below rather than making you guess.",
  },
  {
    path: "/api/data/ocd.json",
    what: "The corpus in Open Civic Data's Event shape.",
    note:
      "Use this if you are ingesting rather than reading. Every event carries at least one source, and meetings we hold no source URL for are omitted and counted rather than emitted unsourced.",
  },
  {
    path: "/api/data/meetings.csv",
    what: "Bulk CSV exports. Swap the stem for any dataset in the manifest.",
  },
  {
    path: "/api/metrics",
    what: "Our own numbers: how much is collected, how much published, how long it takes.",
  },
  {
    path: "/sitemap.xml",
    what: "Every public URL, generated from the database.",
    note: "Published meetings only — an unpublished record is absent, not hidden behind a 403.",
  },
  {
    path: "/robots.txt",
    what: "Crawl policy. Retrieval crawlers and training crawlers are named separately.",
  },
];

function Row({ surface }: { surface: Surface }) {
  return (
    <li className="border-t border-rule py-3">
      <p className="font-mono text-sm">
        <a
          href={surface.path}
          className="underline underline-offset-2"
          rel="noreferrer"
        >
          {surface.path}
        </a>
      </p>
      <p className="mt-1 max-w-prose text-sm leading-relaxed text-ink-soft">{surface.what}</p>
      {surface.note ? (
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">{surface.note}</p>
      ) : null}
    </li>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="mt-12" aria-labelledby={id}>
      <h2 id={id} className="font-display text-xl tracking-headline">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function BotPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <header>
        <p className="kicker">For machines</p>
        <h1 className="headline mt-1.5 text-3xl sm:text-4xl">
          If you are a crawler or an agent
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-soft">
          This site publishes Montana local-government public records — meetings,
          agendas, votes, and the documents underneath them — along with our own
          account of how we collected them. You are welcome here. This page says
          what is available, where, and on what terms, so you do not have to
          infer any of it.
        </p>
      </header>

      <Section id="surfaces" title="Machine-readable surfaces">
        <ul className="mt-2">
          {MACHINE_SURFACES.map((surface) => (
            <Row key={surface.path} surface={surface} />
          ))}
        </ul>
      </Section>

      <Section id="citing" title="How to cite what you find">
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
          Every claim on this site traces to a stored document. Where you see a
          document referenced, it is addressed by the SHA-256 of its bytes rather
          than by a URL on the county's website — so a citation still resolves
          after the source site is reorganised, and you can hash a file yourself
          and confirm it is the one we read.
        </p>
        <p className="mt-3 max-w-prose text-sm leading-relaxed text-ink-soft">
          If you are summarising a record for someone, link them to the meeting
          or the finding rather than to this page. A summary that cannot be
          checked is the thing this project exists to make unnecessary.
        </p>
      </Section>

      <Section id="terms" title="Terms">
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
          Three different things, deliberately not collapsed into one answer:
        </p>
        <dl className="mt-3 space-y-3">
          <div className="border-t border-rule pt-3">
            <dt className="label-sm">The compiled dataset</dt>
            <dd className="mt-1 max-w-prose text-sm leading-relaxed text-ink-soft">
              CC BY 4.0. Attribute to{" "}
              <span className="font-mono text-xs">CommissionWatch — commissionwatch.bmux.sh</span>.
            </dd>
          </div>
          <div className="border-t border-rule pt-3">
            <dt className="label-sm">The code</dt>
            <dd className="mt-1 max-w-prose text-sm leading-relaxed text-ink-soft">MIT.</dd>
          </div>
          <div className="border-t border-rule pt-3">
            <dt className="label-sm">The government documents underneath</dt>
            <dd className="mt-1 max-w-prose text-sm leading-relaxed text-ink-soft">
              Public records. We assert no licence over them at all — they are
              not ours to license.
            </dd>
          </div>
        </dl>
        <p className="mt-4 max-w-prose text-sm leading-relaxed text-ink-soft">
          Full terms on the{" "}
          <Link to="/data" className="underline underline-offset-2">
            open data page
          </Link>
          .
        </p>
      </Section>

      <Section id="wrong" title="If we have something wrong">
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
          Anyone can contest a record, including on behalf of someone else, with
          no account and no proof of identity. Every correction we make is logged
          in public.
        </p>
        <p className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <Link to="/corrections" className="underline underline-offset-2">
            The corrections log
          </Link>
          <Link to="/corrections/dispute" className="underline underline-offset-2">
            Contest a record
          </Link>
          <Link to="/methodology" className="underline underline-offset-2">
            How this works
          </Link>
        </p>
      </Section>

      <p className="mt-12 border-t border-rule pt-4 text-xs leading-relaxed text-muted">
        Rate limits apply to every public endpoint and answer{" "}
        <span className="font-mono">429</span> with a{" "}
        <span className="font-mono">Retry-After</span> header. Honour it and you
        will not be blocked. Base URL:{" "}
        <span className="font-mono">{BASE}</span>
      </p>
    </div>
  );
}
