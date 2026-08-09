import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * `/methodology` — the standing account of how this site produces what it
 * publishes. Static: no fetches, no data dependencies, so it renders even when
 * the API is down. A watchdog site whose methodology page 404s has no standing.
 *
 * Every claim on this page is checkable against the repository. Where a stage
 * is described but not yet running end to end, the page says so in the section
 * itself rather than implying a pipeline that does not exist. Nothing here is
 * aspirational prose dressed as fact.
 *
 * Deliberately not linked from this page: `/corrections`, `/corrections/dispute`
 * and the bulk export paths. Those surfaces are not built yet, and a live link
 * to a 404 is exactly the failure this page exists to prevent.
 */

const REVISED = "August 9, 2026";
const VERSION = "1.1";
const CORRECTIONS_EMAIL = "corrections@commissionwatch.bmux.sh";
const REPO_URL = "https://github.com/nickallevato/commissionwatch";

interface Section {
  readonly id: string;
  readonly title: string;
}

const SECTIONS: readonly Section[] = [
  { id: "publisher", title: "Who publishes this" },
  { id: "sources", title: "Where the record comes from" },
  { id: "pipeline", title: "How a document becomes a record" },
  { id: "detectors", title: "How flags are computed" },
  { id: "findings", title: "Findings and the review gate" },
  { id: "limits", title: "What this project does not do" },
  { id: "corrections", title: "Corrections and disputes" },
];

/* ---------------------------------------------------------------------------
   The six detectors, as implemented
   ------------------------------------------------------------------------- */

interface Detector {
  readonly label: string;
  readonly threshold: string;
  readonly severity: string;
  readonly fires: string;
  readonly caveat: string;
}

/**
 * Descriptions and thresholds mirror `backend/src/services/anomaly-detection.ts`.
 * If a threshold changes there, it changes here in the same commit — a
 * methodology that drifts from the code is worse than none.
 */
const DETECTORS: readonly Detector[] = [
  {
    label: "Emergency session",
    threshold: "status = emergency or special",
    severity: "High",
    fires:
      "The jurisdiction itself convened the meeting as an emergency or special session rather than as a regular one. The flag reads the status the source published; it does not judge whether the emergency was real.",
    caveat:
      "Special sessions are routine and lawful. The flag marks a meeting held outside the ordinary calendar, nothing more.",
  },
  {
    label: "Minutes not published",
    threshold: "> 14 days, no minutes URL",
    severity: "Medium → Critical",
    fires:
      "Fourteen days after a meeting, no minutes document is on the record. Severity rises with the delay: high past 30 days, critical past 90.",
    caveat:
      "Minutes published somewhere we do not yet crawl will read as missing. The flag measures what is on the record, and the record is only as complete as the sources listed above.",
  },
  {
    label: "Quorum issue",
    threshold: "present < ⌊seats ÷ 2⌋ + 1",
    severity: "Critical",
    fires:
      "Fewer distinct members are recorded voting than a simple majority of the members seated on the meeting date. Members recorded absent are not counted as present.",
    caveat:
      "A partial vote record produces this flag as readily as a real quorum failure. Open the minutes before drawing any conclusion.",
  },
  {
    label: "Last-minute agenda change",
    threshold: "< 24 hours before the meeting",
    severity: "Medium",
    fires:
      "An agenda item first appears in the record less than 24 hours before the meeting it is heard at.",
    caveat:
      "This measures when the item entered our record, which is not always when the jurisdiction posted it. A late crawl looks like a late posting.",
  },
  {
    label: "Unanimous vote on a contested item",
    threshold: "≥ 3 voting, all identical",
    severity: "Low",
    fires:
      "Every member voting on a public hearing, zoning, budget or ordinance item voted the same way, with at least three members voting.",
    caveat:
      "Unanimity is common and usually means agreement. Severity is low because this is a prompt to read the item, not a signal on its own.",
  },
  {
    label: "Closed-door vote",
    threshold: "executive or closed session, votes recorded",
    severity: "High",
    fires:
      "Votes are recorded against an item the record describes as an executive or closed session. Procedural motions to enter, exit or return from closed session are excluded.",
    caveat:
      "Closed sessions are lawful for defined purposes. The flag is about votes taken inside one, which is a different question from whether the session was proper.",
  },
];

/* ---------------------------------------------------------------------------
   Pipeline stages
   ------------------------------------------------------------------------- */

interface Stage {
  readonly step: string;
  readonly name: string;
  readonly body: string;
}

const STAGES: readonly Stage[] = [
  {
    step: "01",
    name: "Fetch",
    body: "A scheduled crawler requests the published document from the jurisdiction's own site — the same URL any member of the public can open. Nothing is fetched from a login, a leak, or a source not open to everyone.",
  },
  {
    step: "02",
    name: "Hash",
    body: "The bytes are hashed with SHA-256 before anything reads them. The hash is the document's identity: two records derived from the same hash were derived from the same file.",
  },
  {
    step: "03",
    name: "Store",
    body: "The document is stored as an immutable artifact alongside its source URL, its hash, and the time it was retrieved. Artifacts are never edited in place.",
  },
  {
    step: "04",
    name: "Parse",
    body: "Agendas, minutes and vote tables are read out of the stored copy into structured records: meetings, agenda items, members, votes.",
  },
  {
    step: "05",
    name: "Analyze",
    body: "The detectors below run against those structured records and write flags. A flag always points back to the meeting and item it was raised against.",
  },
];

/* ---------------------------------------------------------------------------
   Boundaries
   ------------------------------------------------------------------------- */

const NOT_DONE: readonly string[] = [
  "Assert motive, intent, corruption or illegality. This site describes what the record shows — votes, timing, procedure, patterns — and stops there.",
  "Transcribe meeting video or attribute spoken statements to a speaker.",
  "Use non-public records, leaked material, or anything obtained other than as a member of the public.",
  "Score, rank or grade officials.",
  "Predict how anyone will vote.",
  "Infer party affiliation for a nonpartisan office. Party is recorded only where the office is partisan and a source states it; blank means unknown, never independent.",
  "Accept payment, from anyone, to publish, suppress, amend or prioritize anything.",
  "Publish anything naming a person without an operator approving it first.",
];

/* ---------------------------------------------------------------------------
   Correction commitments
   ------------------------------------------------------------------------- */

interface Commitment {
  readonly stage: string;
  readonly clock: string;
}

const COMMITMENTS: readonly Commitment[] = [
  { stage: "Acknowledgement with a reference number", clock: "Immediate" },
  { stage: "Dispute read by a person and triaged", clock: "2 business days" },
  {
    stage: "Substantive response — corrected, upheld with reasoning, or clarified",
    clock: "10 business days",
  },
  {
    stage: "Item credibly shown to be materially wrong: unpublished pending review",
    clock: "24 hours",
  },
  { stage: "Correction published", clock: "3 business days" },
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

export function MethodologyPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <header>
        <p className="kicker">How this works</p>
        <h1 className="headline mt-2 text-4xl sm:text-5xl">Methodology</h1>
        <p className="mt-4 max-w-prose text-base leading-relaxed text-ink-soft">
          What this site reads, how it turns a public document into a record,
          what makes it raise a flag, and where the boundaries of the exercise
          are. Written so that a reader who disagrees with a conclusion can find
          the step they disagree with and check it themselves.
        </p>
        <p className="mt-4 text-xs text-muted">
          Version <span className="figure">{VERSION}</span>
          {" · "}
          Revised <span className="figure">{REVISED}</span>
        </p>
      </header>

      <div className="mt-10 lg:grid lg:grid-cols-[minmax(0,1fr)_13rem] lg:gap-12">
        <article className="border-t border-rule pt-8">
          {/* -------------------------------------------------- Standing note */}
          <aside
            aria-label="Status of this page"
            className="border-l-2 border-accent pl-4"
          >
            <p className="label-sm">Where this stands</p>
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
              CommissionWatch is publishing the meeting record and the automated
              flags described below. It is not yet publishing findings — the
              written, reviewed accounts of what a meeting showed. Sections{" "}
              <a href="#findings" className="underline underline-offset-2">
                five
              </a>{" "}
              and{" "}
              <a href="#corrections" className="underline underline-offset-2">
                seven
              </a>{" "}
              describe commitments that bind before the first finding publishes,
              and say plainly which parts of them are already built.
            </p>
          </aside>

          {/* -------------------------------------------------- 1. Publisher */}
          <section className="mt-12" aria-labelledby="publisher">
            <p className="label-sm">One</p>
            <SectionHeading id="publisher">Who publishes this</SectionHeading>
            <Prose>
              CommissionWatch is published by Cold Smoke Consulting, and edited
              by Nick Allevato, who is accountable for everything on it. Not
              &ldquo;the team&rdquo;: a named person, reachable at the address
              below, who answers for a mistake and signs the correction.
            </Prose>
            <Prose>
              The project takes no money from any government, candidate,
              committee, or party, and none from anyone with an interest in what
              it publishes. It is not affiliated with the City of Bozeman,
              Gallatin County, or any agency it reports on.
            </Prose>
            <Prose>
              The code that produces this site is open and public, under the MIT
              license. What the site did on any given day is inspectable in its
              history rather than taken on trust.
            </Prose>
            <p className="mt-4 flex flex-wrap gap-2">
              <a
                className="cite"
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
              >
                Source code · github.com/nickallevato/commissionwatch
              </a>
              <a className="cite" href={`mailto:${CORRECTIONS_EMAIL}`}>
                {CORRECTIONS_EMAIL}
              </a>
            </p>
          </section>

          {/* -------------------------------------------------- 2. Sources */}
          <section className="mt-12" aria-labelledby="sources">
            <p className="label-sm">Two</p>
            <SectionHeading id="sources">
              Where the record comes from
            </SectionHeading>
            <Prose>
              Two jurisdictions are monitored today: the{" "}
              <strong className="font-semibold text-ink">
                Bozeman City Commission
              </strong>{" "}
              and{" "}
              <strong className="font-semibold text-ink">
                Gallatin County, Montana
              </strong>
              . Everything on this site derives from documents those bodies
              published themselves — agendas, minutes, and the vote records
              inside them.
            </Prose>
            <Prose>
              There is no other kind of input. No tips are published as fact, no
              private material is used, and nothing is drawn from a source a
              member of the public could not request or open. Where a document
              exists but has not been read into the record yet, the record is
              incomplete rather than wrong: the site shows what it has and does
              not fill the gap by inference.
            </Prose>
            <Prose>
              Each meeting page carries the agenda and minutes URLs it was built
              from. Follow them to the jurisdiction&rsquo;s own site and compare.
              That is the intended way to read this site.
            </Prose>
            <p className="mt-4 text-sm text-muted">
              A per-source table — every crawler, its URL, its cadence and its
              current health — publishes here when the ingestion registry ships.
              Until it does, this paragraph is the honest version: two
              jurisdictions, crawled on a schedule, with gaps where the crawl
              has not reached.
            </p>

            <h3
              id="robots"
              className="mt-8 scroll-mt-8 font-display text-lg tracking-headline"
            >
              How this site treats robots.txt
            </h3>
            <Prose>
              This site respects <code className="font-mono text-sm">robots.txt</code>{" "}
              by default. There is one exception, and it is disclosed here rather
              than left to be discovered.
            </Prose>
            <Prose>
              Bozeman&rsquo;s agendas and minutes are published through a vendor,
              Granicus, at{" "}
              <a
                className="underline underline-offset-2"
                href="https://bozeman.granicus.com/ViewPublisher.php?view_id=1"
                target="_blank"
                rel="noreferrer"
              >
                bozeman.granicus.com
              </a>
              . That vendor&rsquo;s{" "}
              <code className="font-mono text-sm">robots.txt</code> reads{" "}
              <code className="font-mono text-sm">Disallow: /</code> for every
              client except four named search engines.{" "}
              <strong className="font-semibold text-ink">
                CommissionWatch fetches those records anyway.
              </strong>{" "}
              The reasoning: a blanket vendor robots file is written to manage
              search-engine crawlers, and a city&rsquo;s legal obligation to
              publish its records does not transfer to its hosting
              vendor&rsquo;s convention.
            </Prose>
            <Prose>
              The conditions that fetching runs under are not informal. One
              request every ten seconds — the crawl delay that same file
              publishes — never more than one at a time; a user agent that names
              this project and carries an address a human can reply to, never a
              browser string and never a disguise; and no document fetched twice
              once it is unchanged. No CAPTCHA is solved, no browser fingerprint
              or TLS signature is manipulated, and no proxy is rotated. Where a
              source would require any of those, this project stops and files a
              public-records request instead, which is exactly what it does for{" "}
              <code className="font-mono text-sm">bozemanmt.gov</code> — a host
              that refuses every client, including this one, and is never
              fetched.
            </Prose>
            <Prose>
              If a records custodian asks this project to stop, it stops. And if
              this disclosure is ever removed from this page, the exception ends
              with it: a transparency project does not get to carry a published
              policy it knowingly breaks.
            </Prose>
          </section>

          {/* -------------------------------------------------- 3. Pipeline */}
          <section className="mt-12" aria-labelledby="pipeline">
            <p className="label-sm">Three</p>
            <SectionHeading id="pipeline">
              How a document becomes a record
            </SectionHeading>
            <Prose>
              Five stages, in this order, every time.
            </Prose>

            <ol className="mt-6">
              {STAGES.map((stage) => (
                <li
                  key={stage.step}
                  className="grid grid-cols-[2.5rem_1fr] gap-x-4 border-t border-rule py-4 first:border-t-0 first:pt-0 sm:grid-cols-[3rem_1fr]"
                >
                  <span className="figure pt-0.5 text-sm text-accent">
                    {stage.step}
                  </span>
                  <div>
                    <h3 className="font-display text-lg tracking-headline">
                      {stage.name}
                    </h3>
                    <p className="mt-1 max-w-prose text-sm leading-relaxed text-ink-soft">
                      {stage.body}
                    </p>
                  </div>
                </li>
              ))}
            </ol>

            <div className="mt-6 border-l-2 border-accent pl-4">
              <p className="label-sm">The invariant</p>
              <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink">
                Every stage after <em>fetch</em> reads from the stored copy,
                never from the live web. What you see was derived from one
                specific document with one specific SHA-256, and that document
                can be fetched again from the government and compared byte for
                byte with the one we parsed.
              </p>
            </div>
          </section>

          {/* -------------------------------------------------- 4. Detectors */}
          <section className="mt-12" aria-labelledby="detectors">
            <p className="label-sm">Four</p>
            <SectionHeading id="detectors">
              How flags are computed
            </SectionHeading>
            <Prose>
              Six checks run over the structured record. They are arithmetic and
              pattern matching, not judgement: no model decides whether a flag
              fires. A flag is a reason to open the document, never a conclusion
              about anyone.
            </Prose>

            <div className="mt-6">
              {DETECTORS.map((detector) => (
                <div key={detector.label} className="border-t border-rule py-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                    <h3 className="font-display text-lg tracking-headline">
                      {detector.label}
                    </h3>
                    <span className="label-sm">{detector.severity}</span>
                  </div>
                  <p className="figure mt-1 text-xs text-muted">
                    {detector.threshold}
                  </p>
                  <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
                    {detector.fires}
                  </p>
                  <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted">
                    <span className="label-sm mr-2">Does not mean</span>
                    {detector.caveat}
                  </p>
                </div>
              ))}
            </div>

            <p className="mt-6 max-w-prose text-sm leading-relaxed text-ink-soft">
              Severity orders the reading queue. It is not a measure of
              wrongdoing, and a critical flag on a meeting means the record
              looks incomplete or irregular, not that anyone did anything wrong.
              Every flag is listed, with its meeting and its source document, on{" "}
              <Link
                to="/anomalies"
                className="underline underline-offset-2 hover:text-accent"
              >
                the flag ledger
              </Link>
              .
            </p>
          </section>

          {/* -------------------------------------------------- 5. Findings */}
          <section className="mt-12" aria-labelledby="findings">
            <p className="label-sm">Five</p>
            <SectionHeading id="findings">
              Findings and the review gate
            </SectionHeading>
            <Prose>
              A finding is a written account of what a meeting showed. None have
              been published yet. When they are, these rules hold and are
              enforced in code rather than promised in prose:
            </Prose>
            <ul className="mt-4 max-w-prose">
              {[
                "Nothing naming a person publishes automatically. An operator reviews it, approves it, and is recorded as having done so, with a timestamp.",
                "Every claim in a finding cites the document it came from — a specific agenda, minutes file, or vote record, by URL and hash.",
                "The model and the prompt version that produced a finding are recorded with it and shown on the page.",
                "The generation prompt is published in the repository. A transparency project that keeps its own prompt secret is asking for a trust it does not extend.",
                "A claim the record does not support is not published, however plausible it reads.",
              ].map((rule) => (
                <li
                  key={rule}
                  className="border-t border-rule py-3 text-sm leading-relaxed text-ink-soft first:border-t-0"
                >
                  {rule}
                </li>
              ))}
            </ul>
          </section>

          {/* -------------------------------------------------- 6. Limits */}
          <section className="mt-12" aria-labelledby="limits">
            <p className="label-sm">Six</p>
            <SectionHeading id="limits">
              What this project does not do
            </SectionHeading>
            <Prose>
              The boundaries are the part people get wrong, so they are stated
              rather than implied. CommissionWatch does not:
            </Prose>
            <ul className="mt-4 max-w-prose">
              {NOT_DONE.map((item) => (
                <li
                  key={item}
                  className="border-t border-rule py-3 text-sm leading-relaxed text-ink-soft first:border-t-0"
                >
                  {item}
                </li>
              ))}
            </ul>
          </section>

          {/* -------------------------------------------------- 7. Corrections */}
          <section className="mt-12" aria-labelledby="corrections">
            <p className="label-sm">Seven</p>
            <SectionHeading id="corrections">
              Corrections and disputes
            </SectionHeading>
            <Prose>
              A site that cannot itself be corrected has no standing to ask
              anyone else for accountability. If something here is wrong, say
              so, and it gets fixed on the clock below.
            </Prose>
            <Prose>
              Write to{" "}
              <a
                href={`mailto:${CORRECTIONS_EMAIL}`}
                className="underline underline-offset-2 hover:text-accent"
              >
                {CORRECTIONS_EMAIL}
              </a>
              . Include the URL of the item, what specifically is wrong, and — if
              you have it — the document that shows the correct fact. You do not
              have to say who you are. An anonymous dispute pointing at a
              document that proves this site wrong is still right.
            </Prose>

            <div className="mt-6 overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <caption className="sr-only">
                  Response commitments for a dispute, by stage
                </caption>
                <thead>
                  {/* `label-sm` sets `display: inline-block`, which would take a
                      `<th>` out of the table layout — so it goes on a span. */}
                  <tr className="border-b border-ink">
                    <th scope="col" className="pb-2 pr-4 text-left align-bottom">
                      <span className="label-sm">Stage</span>
                    </th>
                    <th
                      scope="col"
                      className="w-40 pb-2 text-right align-bottom"
                    >
                      <span className="label-sm">Commitment</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {COMMITMENTS.map((commitment) => (
                    <tr
                      key={commitment.stage}
                      className="border-b border-rule align-top"
                    >
                      <td className="py-3 pr-4 text-sm text-ink-soft">
                        {commitment.stage}
                      </td>
                      <td className="figure py-3 text-right text-sm text-ink">
                        {commitment.clock}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Prose>
              Two rules make this more than a paragraph of intent.{" "}
              <strong className="font-semibold text-ink">
                Unpublishing is not deleting
              </strong>
              : an item pulled pending review is replaced at its own URL by a
              notice saying so and when, with the original text preserved. A URL
              on this site never quietly changes meaning and never 404s.{" "}
              <strong className="font-semibold text-ink">
                A correction is never a silent edit
              </strong>
              : the published text is snapshotted before it is amended, and the
              corrected item carries a permanent notice pointing at the
              correction.
            </Prose>
            <p className="mt-4 max-w-prose text-sm leading-relaxed text-muted">
              The public corrections log — every correction, permanently, with
              the open-dispute clock computed rather than asserted — publishes
              with the first finding. Until then, corrections are made by email
              and this page carries the commitment.
            </p>
          </section>

          <hr className="mt-12 border-t border-rule" />
          <p className="mt-4 text-sm text-muted">
            How to reuse anything on this site:{" "}
            <Link
              to="/data-license"
              className="underline underline-offset-2 hover:text-accent"
            >
              data license
            </Link>
            .
          </p>
        </article>

        {/* -------------------------------------------------- Contents rail */}
        {/* Below the article on small screens — the page is short enough to
            scroll — and a rail beside it from lg up. */}
        <nav
          aria-label="On this page"
          className="mt-10 border-t border-rule pt-4 lg:mt-0 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-8"
        >
          <p className="label-sm">On this page</p>
          <ol className="mt-3 lg:sticky lg:top-8">
            {SECTIONS.map((section, index) => (
              <li key={section.id} className="flex gap-3 py-1.5">
                <span className="figure text-xs text-muted">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <a
                  href={`#${section.id}`}
                  className="text-sm leading-snug text-ink-soft hover:text-accent"
                >
                  {section.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      </div>
    </div>
  );
}
