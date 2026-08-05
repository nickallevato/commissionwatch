import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * `/data-license` — the terms under which this site's data can be reused, what
 * is withheld from it and why, and how to verify any record against the
 * government document it came from. Static: no fetches, so it renders when the
 * API does not.
 *
 * Three layers are licensed separately and are never conflated: the compiled
 * dataset (CC BY 4.0), the code (MIT, per the repository LICENSE file), and the
 * underlying government documents (public records, no license asserted here).
 *
 * As on `/methodology`, nothing links to a surface that does not exist. The bulk
 * export paths are described as planned, in plain words, rather than linked.
 */

const REVISED = "August 4, 2026";
const SITE = "commissionwatch.bmux.sh";
const REPO_URL = "https://github.com/nickallevato/commissionwatch";
const CC_BY_URL = "https://creativecommons.org/licenses/by/4.0/";
const CORRECTIONS_EMAIL = "corrections@commissionwatch.bmux.sh";

/* ---------------------------------------------------------------------------
   The three layers
   ------------------------------------------------------------------------- */

interface Layer {
  readonly layer: string;
  readonly license: string;
  readonly note: string;
}

const LAYERS: readonly Layer[] = [
  {
    layer: "The compiled dataset",
    license: "CC BY 4.0",
    note: "The selection, structure, and generated text: meetings, agenda items, members, votes, flags, and any published findings, as assembled here.",
  },
  {
    layer: "The code",
    license: "MIT",
    note: "Everything in the repository — crawlers, parsers, detectors, API, and this site.",
  },
  {
    layer: "The government documents",
    license: "No license asserted",
    note: "Agendas, minutes, and the files they link to are public records produced by the jurisdictions. They are not ours to relicense.",
  },
];

/* ---------------------------------------------------------------------------
   What is withheld
   ------------------------------------------------------------------------- */

interface Withheld {
  readonly what: string;
  readonly why: string;
}

const WITHHELD: readonly Withheld[] = [
  {
    what: "Alert subscriptions, in full",
    why: "Subscriber email addresses. There is no public interest in them whatsoever.",
  },
  {
    what: "Notifications, in full",
    why: "Every row is linked to a recipient.",
  },
  {
    what: "Verification and unsubscribe tokens",
    why: "Credentials. Publishing them would let anyone act as a subscriber.",
  },
  {
    what: "Delivery channel configuration",
    why: "Encrypted credentials and operational routing.",
  },
  {
    what: "Who filed a dispute",
    why: "The substance of a dispute publishes. The person does not, unless they ask for it to.",
  },
  {
    what: "Document embedding vectors",
    why: "Derivative and regenerable from the documents. The row metadata is exported; the floats are not.",
  },
  {
    what: "Findings that are not published",
    why: "Exporting drafts would route around the review gate, which is the point of having one.",
  },
  {
    what: "The bytes of source documents",
    why: "Not ours to redistribute. Every record names the source URL and the SHA-256 instead, so you can fetch the original from the government and verify it is the same file.",
  },
];

/* ---------------------------------------------------------------------------
   API surface, as mounted
   ------------------------------------------------------------------------- */

/** Mirrors the routers mounted in `backend/src/app.ts`. */
const ENDPOINTS: readonly string[] = [
  "/api/jurisdictions",
  "/api/meetings",
  "/api/members",
  "/api/votes",
  "/api/anomalies",
  "/api/health",
];

/* ---------------------------------------------------------------------------
   Small parts
   ------------------------------------------------------------------------- */

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

function Prose({ children }: { children: ReactNode }) {
  return (
    <p className="mt-4 max-w-prose text-[0.9375rem] leading-relaxed text-ink-soft">
      {children}
    </p>
  );
}

/* ---------------------------------------------------------------------------
   Page
   ------------------------------------------------------------------------- */

export function DataLicensePage() {
  return (
    <div className="mx-auto max-w-3xl">
      <header>
        <p className="kicker">Open data</p>
        <h1 className="headline mt-2 text-4xl sm:text-5xl">Data license</h1>
        <p className="mt-4 max-w-prose text-base leading-relaxed text-ink-soft">
          &ldquo;Here is what the record shows&rdquo; is only a checkable claim
          if you can get the record. These are the terms for taking this data
          and using it — including to contradict us.
        </p>
        <p className="mt-4 text-xs text-muted">
          Revised <span className="figure">{REVISED}</span>
        </p>
      </header>

      <article className="mt-10 border-t border-rule pt-8">
        {/* -------------------------------------------------- Layers */}
        <section aria-labelledby="layers">
          <SectionHeading id="layers">Three layers, three licenses</SectionHeading>
          <Prose>
            What you are reusing determines the terms. These are never
            conflated, because the third layer is not ours.
          </Prose>

          <div className="mt-6 overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">
                License applying to each layer of the site
              </caption>
              <thead>
                {/* `label-sm` sets `display: inline-block`, which would take a
                    `<th>` out of the table layout — so it goes on a span. */}
                <tr className="border-b border-ink">
                  <th scope="col" className="pb-2 pr-4 text-left align-bottom">
                    <span className="label-sm">Layer</span>
                  </th>
                  <th scope="col" className="w-44 pb-2 text-right align-bottom">
                    <span className="label-sm">License</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {LAYERS.map((layer) => (
                  <tr key={layer.layer} className="border-b border-rule align-top">
                    <td className="py-3 pr-4">
                      <span className="text-sm font-semibold text-ink">
                        {layer.layer}
                      </span>
                      <span className="mt-1 block max-w-prose text-sm leading-relaxed text-muted">
                        {layer.note}
                      </span>
                    </td>
                    <td className="py-3 text-right text-sm text-ink">
                      {layer.license}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-4 flex flex-wrap gap-2">
            <a className="cite" href={CC_BY_URL} target="_blank" rel="noreferrer">
              CC BY 4.0 · creativecommons.org
            </a>
            <a className="cite" href={REPO_URL} target="_blank" rel="noreferrer">
              MIT · github.com/nickallevato/commissionwatch
            </a>
          </p>
        </section>

        {/* -------------------------------------------------- Attribution */}
        <section className="mt-12" aria-labelledby="attribution">
          <SectionHeading id="attribution">How to attribute</SectionHeading>
          <Prose>
            Under CC BY 4.0 you may copy, redistribute, and build on this
            dataset for any purpose, including commercially, as long as you
            credit it. One line is enough:
          </Prose>
          <p className="mt-4 border-l-2 border-accent pl-4 font-mono text-sm leading-relaxed text-ink">
            Data from CommissionWatch — {SITE}, CC BY 4.0.
          </p>
          <Prose>
            The license covers the compilation, not the facts. That a
            commissioner voted no on the fourteenth of July is not
            copyrightable, is not ours, and needs no permission from anyone.
            What is licensed is the work of assembling those facts into a
            structured, checkable record.
          </Prose>
          <div className="mt-6 border-l-2 border-rule pl-4">
            <p className="label-sm">A request, not a term</p>
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
              If you republish a finding, republish its corrections status with
              it. This is asked, not required — CC BY forbids imposing extra
              restrictions, and pretending otherwise would be a false claim
              about the license. The API carries corrections on every finding so
              that honoring it costs nothing.
            </p>
          </div>
        </section>

        {/* -------------------------------------------------- Getting the data */}
        <section className="mt-12" aria-labelledby="getting">
          <SectionHeading id="getting">Getting the data</SectionHeading>
          <Prose>
            The API is public, read-only, unauthenticated, and returns JSON.
            There is no key and no signup form: putting one in front of public
            records is friction that buys nothing. Cross-origin requests are
            allowed, so you can read it straight from a browser.
          </Prose>
          <ul className="mt-4 flex flex-wrap gap-2">
            {ENDPOINTS.map((endpoint) => (
              <li key={endpoint} className="cite figure">
                {endpoint}
              </li>
            ))}
          </ul>
          <Prose>
            Be reasonable with it. If you want everything, wait for the bulk
            export rather than crawling the API: nightly CSV and JSON Lines per
            table, a full zip, and a manifest carrying a SHA-256 and a row count
            for every file, with dated snapshots kept so that &ldquo;what did
            this site say in March&rdquo; stays answerable. That export is not
            published yet. When it is, it will be linked from this page and
            described here in full — not announced somewhere else and left for
            you to find.
          </Prose>
        </section>

        {/* -------------------------------------------------- Withheld */}
        <section className="mt-12" aria-labelledby="withheld">
          <SectionHeading id="withheld">
            What is withheld, and why
          </SectionHeading>
          <Prose>
            An omission you have to notice is not transparency. Everything held
            back from the public data is listed here, with the reason.
          </Prose>

          <div className="mt-6 overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">
                Data withheld from the public dataset, with the reason for each
              </caption>
              <thead>
                <tr className="border-b border-ink">
                  <th
                    scope="col"
                    className="w-56 pb-2 pr-4 text-left align-bottom"
                  >
                    <span className="label-sm">Withheld</span>
                  </th>
                  <th scope="col" className="pb-2 text-left align-bottom">
                    <span className="label-sm">Reason</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {WITHHELD.map((row) => (
                  <tr key={row.what} className="border-b border-rule align-top">
                    <td className="py-3 pr-4 text-sm font-semibold text-ink">
                      {row.what}
                    </td>
                    <td className="py-3 text-sm leading-relaxed text-ink-soft">
                      {row.why}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Prose>
            An official&rsquo;s government email address is{" "}
            <em>not</em> withheld where the jurisdiction publishes it itself.
            Withholding a published official contact from a transparency dataset
            would be theatre. Personal addresses are never collected, so there
            are none to withhold. Party affiliation is blank for nonpartisan
            offices because it was never inferred — blank means unknown, not
            independent.
          </Prose>
        </section>

        {/* -------------------------------------------------- Verifying */}
        <section className="mt-12" aria-labelledby="verifying">
          <SectionHeading id="verifying">Verifying a record</SectionHeading>
          <Prose>
            Every record traces to a document the jurisdiction published. Take
            the source URL from the meeting page, fetch the file from the
            government yourself, and compare its SHA-256 with the one recorded
            here. If the hashes match, you are holding the exact file this site
            parsed. If they do not, the document changed after we read it, and
            that is worth knowing on its own.
          </Prose>
          <Prose>
            If you find a record that the source document does not support,
            write to{" "}
            <a
              href={`mailto:${CORRECTIONS_EMAIL}`}
              className="underline underline-offset-2 hover:text-accent"
            >
              {CORRECTIONS_EMAIL}
            </a>
            . How that is handled, and on what clock, is set out in the{" "}
            <Link
              to="/methodology"
              className="underline underline-offset-2 hover:text-accent"
            >
              methodology
            </Link>
            .
          </Prose>
        </section>

        {/* -------------------------------------------------- Not legal advice */}
        <hr className="mt-12 border-t border-rule" />
        <p className="mt-4 max-w-prose text-sm leading-relaxed text-muted">
          This page describes the terms this project offers. It is not legal
          advice, and it does not speak for the jurisdictions whose documents
          the record is built from.
        </p>
      </article>
    </div>
  );
}
