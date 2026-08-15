import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CellLabel } from "@/components/ui/CellLabel";
import type {
  ExtractionFailureReason,
  PublicExtraction,
  PublicStatus,
  PublicStatusSource,
} from "@/types";

/**
 * `/status` — what this site has and has not collected, in public.
 *
 * A watchdog site that goes quiet looks exactly like a city that has gone
 * quiet. This page is the difference. Every figure on it is read from
 * `ingestion_sources` and `ingestion_runs` at load: there is no maintained
 * list here, because a status page maintained by hand is a status page that
 * lies eventually, and this project's whole claim is that it does not do that.
 *
 * Four rules the page holds to, each of which has a way of quietly eroding:
 *
 * 1. **Nothing is filtered.** A source that has never run is shown as never
 *    run. A source that is switched off is shown switched off, with the reason.
 *    An absence you can see is a commitment; an absence you cannot is a quiet
 *    failure, and omitting the sources that embarrass us is how the second one
 *    happens.
 * 2. **Silence is a state.** A source past its own expected interval reads
 *    *Suspect*, with both numbers printed so a reader can disagree with the
 *    verdict without leaving the page. A stalled scraper and a quiet month at
 *    City Hall must not render identically.
 * 3. **Figures, not text.** The API hands back record counts and failure
 *    counts, never a run's error string — that string is written by whatever
 *    threw and can quote a document belonging to a meeting no operator has
 *    published. Counts are ours to publish; content is not.
 * 4. **The collection disclosure stays whole.** The vendor-`robots.txt`
 *    exception is summarised here and stated in full on the Methodology page,
 *    and the project rule is that the exception is valid only while it is
 *    disclosed. Weakening either page ends the exception.
 * 5. **Unmeasured is not zero.** Collecting a document and reading it are
 *    different steps that fail differently, so the backlog is on this page —
 *    and until something has actually attempted to read a chunk, the page says
 *    the failure rate is unknown. A share computed over nothing is 0, and
 *    printing that 0 would be the most flattering claim available made on no
 *    evidence at all. That is the exact failure this project reports in other
 *    people's publications.
 *
 * Front-of-house, so the ground is `paper` and the chrome is the ordinary site
 * chrome. `PressroomUI` carries the console's, and this is not the console.
 */

const VERDICT_LABEL: Record<PublicStatusSource["verdict"], string> = {
  disabled: "Disabled",
  never_run: "Never run",
  failing: "Failing",
  suspect: "Suspect",
  healthy: "Healthy",
};

/** Only `healthy` gets the green. Everything else is red or plain. */
const VERDICT_CLASS: Record<PublicStatusSource["verdict"], string> = {
  disabled: "text-muted",
  never_run: "text-accent",
  failing: "text-accent",
  suspect: "text-accent",
  healthy: "text-pass",
};

function formatStamp(value: string | null): string {
  if (value === null) return "Never";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Never";
  return parsed.toLocaleString();
}

type LoadResult = { ok: true; status: PublicStatus } | { ok: false };

export function StatusPage() {
  const [status, setStatus] = useState<PublicStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchStatus = useCallback(async (): Promise<LoadResult> => {
    try {
      const res = await fetch("/api/ingestion/sources");
      if (!res.ok) return { ok: false };
      return { ok: true, status: (await res.json()) as PublicStatus };
    } catch {
      return { ok: false };
    }
  }, []);

  useEffect(() => {
    let ignore = false;
    void (async () => {
      const result = await fetchStatus();
      if (ignore) return;
      if (result.ok) {
        setStatus(result.status);
        setError("");
      } else {
        // Said plainly. A status page that fails to load and renders an empty
        // table is claiming there is nothing to report.
        setError("The collection status could not be loaded, so this page is not reporting on it.");
      }
      setLoading(false);
    })();
    return () => {
      ignore = true;
    };
  }, [fetchStatus]);

  const sources = status?.sources ?? [];

  return (
    <div>
      <p className="kicker">Collection status</p>
      <h1 className="headline text-3xl sm:text-4xl mt-1">What this site has collected</h1>
      <div className="rule-hi mt-4" role="presentation" />

      <p className="mt-5 max-w-prose text-sm leading-relaxed text-ink-soft">
        Every figure on this page is read from this site&rsquo;s own ingestion
        records when the page loads. Nothing here is maintained by hand. A
        source that has never run says so; a source that is switched off says
        why; a source that has gone quiet past its own expected interval is
        marked suspect rather than left looking calm.
      </p>

      {error && (
        <p
          role="alert"
          className="mt-6 max-w-prose border-l-2 border-accent bg-paper px-4 py-3 text-sm text-ink-soft"
        >
          {error}
        </p>
      )}

      <section className="mt-10" aria-labelledby="last-sweep">
        <h2 id="last-sweep" className="label-sm">
          Last successful sweep
        </h2>
        <p className="figure mt-2 text-2xl text-ink tabular">
          {loading
            ? "—"
            : status === null || status.last_successful_sweep_at === null
              ? "No sweep yet"
              : formatStamp(status.last_successful_sweep_at)}
        </p>
        {!loading && status !== null && status.last_successful_sweep_at === null && (
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-accent">
            No source has completed a sweep that reached the database. Nothing on
            this site has been collected automatically.
          </p>
        )}
      </section>

      <section className="mt-12" aria-labelledby="sources">
        <h2 id="sources" className="font-display text-xl font-semibold text-ink">
          Sources
        </h2>

        {loading ? (
          <p className="mt-3 label-sm" role="status">
            Loading collection status…
          </p>
        ) : sources.length === 0 ? (
          <div className="mt-4 border-l-2 border-accent bg-paper-sunk px-4 py-3">
            <p className="text-sm text-ink">No ingestion source is registered.</p>
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-accent">
              Nothing is being watched. That is a configuration gap, not a quiet week.
            </p>
          </div>
        ) : (
          <>
            <p className="mt-3 max-w-prose text-sm text-muted">
              {sources.length} registered {sources.length === 1 ? "source" : "sources"}, including
              the ones that are switched off and the ones that have never run.
            </p>

            {/* Six columns do not fit a phone, and horizontal scroll is the
                worst possible answer here: this is the page a reader opens to
                check whether a source has gone quiet, often while a meeting is
                happening, and a sideways-scrolling table hides the "Silence
                watch" column exactly when it matters. Below `sm` the table
                reflows to a stack of cards — each row a card, each cell
                labelled in place — and the scroll container only engages from
                `sm` up, where the grid is genuinely wider than the viewport.

                The explicit `role`s are not redundancy. Setting a table
                element to `display: block` strips its implicit table
                semantics in every browser, so the roles are what keep the
                stacked layout a table to a screen reader instead of a run of
                anonymous divs. At `sm` and up they restate what the tags
                already mean, which costs nothing. */}
            <div className="mt-4 border border-rule bg-paper sm:overflow-x-auto">
              <table
                role="table"
                className="block w-full border-collapse text-left sm:table sm:min-w-[52rem]"
              >
                <caption className="sr-only">
                  Every registered ingestion source, its verdict, the records it has ever produced,
                  its last successful sweep and its silence watch
                </caption>
                {/* Hidden, not `sr-only`, below `sm`: each cell carries its own
                    visible label there, and a screen reader reading both the
                    column header and the in-cell label would say everything
                    twice. */}
                <thead role="rowgroup" className="hidden sm:table-header-group">
                  <tr role="row" className="border-b border-rule">
                    <th scope="col" className="label-sm px-4 py-3">Source</th>
                    <th scope="col" className="label-sm px-4 py-3">State</th>
                    <th scope="col" className="label-sm px-4 py-3">Records collected</th>
                    <th scope="col" className="label-sm px-4 py-3">Last success</th>
                    <th scope="col" className="label-sm px-4 py-3">Silence watch</th>
                    <th scope="col" className="label-sm px-4 py-3">Latest run</th>
                  </tr>
                </thead>
                <tbody
                  role="rowgroup"
                  className="block divide-y divide-rule sm:table-row-group"
                >
                  {sources.map((source) => (
                    <SourceRow key={source.adapter_key} source={source} />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="mt-12" aria-labelledby="reading">
        <h2 id="reading" className="font-display text-xl font-semibold text-ink">
          How much of it has been read
        </h2>
        <p className="mt-3 max-w-prose text-sm leading-relaxed text-ink-soft">
          Collecting a document and reading it are separate steps that fail
          separately. Above is what has been fetched; this is how much of it a
          model has been through, quoting the record back with a citation for
          every sentence. Reading is started by hand rather than on a schedule,
          because a measured share of it still comes back cut off &mdash; so a
          backlog here is work waiting, not work lost.
        </p>

        {loading ? (
          <p className="mt-3 label-sm" role="status">
            Loading the reading backlog&hellip;
          </p>
        ) : status === null || status.extraction === undefined ? (
          <p className="mt-4 max-w-prose border-l-2 border-accent bg-paper px-4 py-3 text-sm leading-relaxed text-ink-soft">
            The reading backlog could not be read, so this page is not reporting
            one. That is not the same as there being nothing to read.
          </p>
        ) : (
          <ExtractionPanel extraction={status.extraction} />
        )}
      </section>

      {/* ------------------------------------------------- collection conduct */}
      <section className="mt-12 max-w-prose" aria-labelledby="conduct">
        <h2 id="conduct" className="font-display text-xl font-semibold text-ink">
          How this site collects
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          Everything collected here is public record, published by the city or
          the county on its own site. It is fetched slowly — at most one request
          every few seconds, never several at once — by a program that identifies
          itself by name and gives an address a human can reply to. It never
          pretends to be a browser. A document that has not changed is not
          fetched again. No CAPTCHA is solved, no browser fingerprint or TLS
          signature is altered, and no proxy is rotated: where a source would
          need any of that, this project stops and asks for the record instead.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          There is one exception, and it is stated rather than left to be found.
          Bozeman&rsquo;s agendas and minutes are published through a vendor,
          Granicus, whose{" "}
          <code className="font-mono text-sm">robots.txt</code> reads{" "}
          <code className="font-mono text-sm">Disallow: /</code> for every client
          except four named search engines.{" "}
          <strong className="font-semibold text-ink">
            CommissionWatch fetches those records anyway
          </strong>
          , at the ten-second crawl delay that same file publishes. A blanket
          vendor robots file is written to manage search-engine crawlers, and a
          city&rsquo;s legal obligation to publish its records does not transfer
          to its hosting vendor&rsquo;s convention.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          <strong className="font-semibold text-ink">
            That exception is valid only while it is disclosed.
          </strong>{" "}
          If this disclosure is ever taken down, the exception ends with it — a
          transparency project does not get to carry a published policy it
          knowingly breaks. And if a records custodian asks this project to stop,
          it stops. The full account is on the{" "}
          <Link className="cite" to="/methodology#robots">
            Methodology page
          </Link>
          .
        </p>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          One host is refused outright and is never fetched:{" "}
          <code className="font-mono text-sm">bozemanmt.gov</code> returns a
          blanket block to every client, including this one. Where a source is
          switched off above, the reason is printed with it.
        </p>
      </section>

      <section className="mt-10 max-w-prose" aria-labelledby="ask">
        <h2 id="ask" className="font-display text-xl font-semibold text-ink">
          Or ask for the record directly
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          Nothing on this page is a substitute for the statutory route, and that
          route is offered to you as well as used by this project. Where a
          document is referenced in the published record and is not in it,{" "}
          <Link className="cite" to="/public-records">
            Request a record
          </Link>{" "}
          drafts the letter for you to send under your own name. Nothing is sent
          on your behalf and nothing you type is stored.
        </p>
      </section>
    </div>
  );
}

/**
 * Every recorded way a passage can go unread, in the reader's words.
 *
 * A `Record` over the closed union rather than a lookup with a fallback: if the
 * backend adds a reason, this stops compiling, which is the only reliable way a
 * new category gets a sentence instead of quietly rendering as its own
 * identifier.
 */
const READING_FAILURE: Record<ExtractionFailureReason, string> = {
  "upstream-error": "the model service returned an error",
  truncated: "the reply hit its length limit before anything was written",
  refused: "the model's content filter refused the passage",
  "reasoning-only": "the model returned its own working and no answer",
  "no-choices": "the service answered with nothing at all",
  "malformed-payload": "the reply was not in the documented shape",
  "empty-content": "the reply finished normally and was empty",
  "request-failed": "the request never came back",
  "unreadable-reply": "the reply held nothing that could be read",
  "truncated-reply": "the reply was cut off part-way through",
  "repetition-truncated": "the model began repeating itself and was cut off while doing so",
  unclassified: "the reason was not recorded",
};

/** A share as a whole percentage, from a fraction the API computed. */
function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/**
 * The backlog, and the failure rate — or the honest absence of one.
 *
 * Rule 5. The `measured: false` branch says *unknown*, in words, and prints no
 * percentage: the API cannot send one, and this component must not compute one
 * either.
 */
function ExtractionPanel({ extraction }: { extraction: PublicExtraction }) {
  const { reading } = extraction;
  const nothingStored = extraction.eligible === 0;

  return (
    <>
      <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3">
        <div className="border-t border-rule pt-3">
          <dt className="label-sm">Records read</dt>
          <dd className="mt-1">
            <span className="figure text-2xl tabular" data-testid="extraction-read">
              {extraction.read}
            </span>
            <span className="text-sm text-muted">
              {" of "}
              <span className="figure tabular">{extraction.eligible}</span>
            </span>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Sets of minutes held here, and how many something has been through.
            </p>
          </dd>
        </div>

        <div className="border-t border-rule pt-3">
          <dt className="label-sm">Waiting to be read</dt>
          <dd className="mt-1">
            <span
              data-testid="extraction-unread"
              className={`figure text-2xl tabular ${
                extraction.unread > 0 ? "text-accent" : "text-ink"
              }`}
            >
              {extraction.unread}
            </span>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              {nothingStored
                ? "Nothing is stored to read yet."
                : "Stored, cited and searchable already. Nothing has read them for claims."}
            </p>
          </dd>
        </div>

        <div className="border-t border-rule pt-3">
          <dt className="label-sm">Reading jobs</dt>
          <dd className="mt-1">
            <span className="figure text-2xl tabular" data-testid="extraction-queued">
              {extraction.queued}
            </span>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              queued or running &middot;{" "}
              <span className="figure tabular">{extraction.blocked}</span> held back
              &middot; <span className="figure tabular">{extraction.failed}</span> gave
              up
            </p>
          </dd>
        </div>
      </dl>

      <h3 className="mt-8 font-sans text-base font-semibold text-ink">
        How much of a document gets read
      </h3>

      {reading.measured ? (
        <>
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
            Across{" "}
            <span className="figure tabular">{reading.runs}</span> attempts over{" "}
            <span className="figure tabular">{reading.meetings}</span> records,{" "}
            <strong className="font-semibold text-ink">
              <span className="figure tabular" data-testid="chunks-unread">
                {reading.chunks_unread}
              </span>{" "}
              of <span className="figure tabular">{reading.chunks}</span> passages
              went unread ({percent(reading.unread_fraction)})
            </strong>
            .{" "}
            {reading.claims_recovered > 0 ? (
              <>
                <span className="figure tabular">{reading.claims_recovered}</span>{" "}
                cited statements were still salvaged from the part that arrived
                before the cut, which is why an unread passage is not the same as
                an unread document.
              </>
            ) : (
              "Nothing was salvaged from them."
            )}
          </p>
          {reading.reasons.length > 0 && (
            <ul className="mt-3 max-w-prose space-y-1 text-sm text-ink-soft">
              {reading.reasons.map((tally) => (
                <li key={tally.reason}>
                  <span className="figure tabular">{tally.chunks}</span>{" "}
                  {tally.chunks === 1 ? "passage" : "passages"} &mdash;{" "}
                  {READING_FAILURE[tally.reason]}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p
          data-testid="reading-unmeasured"
          className="mt-2 max-w-prose border-l-2 border-accent bg-paper px-4 py-3 text-sm leading-relaxed text-ink-soft"
        >
          <strong className="font-semibold text-ink">Not measured.</strong>{" "}
          {reading.runs === 0
            ? "Nothing has attempted to read a document yet, so there is no failure rate to report."
            : `${reading.runs} attempts are on record and none of them got as far as a passage, so there is still no failure rate to report.`}{" "}
          That is unknown, not a clean sheet: a share worked out over nothing at
          all comes to zero, and printing that zero would be this site claiming
          the best possible result on no evidence.
        </p>
      )}
    </>
  );
}

function SourceRow({ source }: { source: PublicStatusSource }) {
  const zero = source.lifetime_records === 0;

  return (
    <tr
      role="row"
      className="block p-4 align-top sm:table-row sm:p-0"
    >
      <th
        scope="row"
        role="rowheader"
        className="block px-0 pb-3 text-left font-normal sm:table-cell sm:px-4 sm:py-4 sm:pb-4"
      >
        <span className="block text-sm font-semibold text-ink">{source.adapter_key}</span>
        <span className="block text-xs text-muted">
          {source.jurisdiction.name}, {source.jurisdiction.state}
        </span>
      </th>

      <td role="cell" className="block px-0 py-2 sm:table-cell sm:px-4 sm:py-4">
        <CellLabel>State</CellLabel>
        <span className={`text-sm font-semibold ${VERDICT_CLASS[source.verdict]}`}>
          {VERDICT_LABEL[source.verdict]}
        </span>
        {!source.enabled && (
          // Rule 1. The reason is in the open, not behind a disclosure: this is
          // the page where "why is Bozeman missing?" gets its answer, and an
          // answer a reader has to click for is an answer half of them never see.
          <span className="mt-1.5 block max-w-[22rem] text-xs leading-relaxed text-ink-soft">
            {source.disabled_reason ?? "No reason was recorded, which is itself a defect."}
          </span>
        )}
      </td>

      <td role="cell" className="block px-0 py-2 sm:table-cell sm:px-4 sm:py-4">
        <CellLabel>Records collected</CellLabel>
        <span
          data-testid={`records-${source.adapter_key}`}
          className={`figure text-base tabular ${zero ? "font-semibold text-accent" : "text-ink"}`}
        >
          {source.lifetime_records}
        </span>
        {zero && (
          <span className="mt-1 block max-w-[16rem] text-xs leading-relaxed text-accent">
            Nothing has ever been collected from this source.
          </span>
        )}
      </td>

      <td
        role="cell"
        className="block px-0 py-2 text-sm text-ink tabular sm:table-cell sm:px-4 sm:py-4"
      >
        <CellLabel>Last success</CellLabel>
        {formatStamp(source.last_success_at)}
      </td>

      <td
        role="cell"
        className="block px-0 py-2 sm:table-cell sm:px-4 sm:py-4"
        data-testid={`silence-${source.adapter_key}`}
      >
        <CellLabel>Silence watch</CellLabel>
        <SilenceCell source={source} />
      </td>

      <td role="cell" className="block px-0 py-2 sm:table-cell sm:px-4 sm:py-4">
        <CellLabel>Latest run</CellLabel>
        {source.latest_run === null ? (
          <span className="text-sm text-accent">Never run</span>
        ) : (
          <>
            <span className="text-sm font-semibold text-ink">{source.latest_run.status}</span>
            <span className="mt-1 block text-xs text-muted tabular">
              {formatStamp(source.latest_run.started_at)}
            </span>
            <span className="mt-1 block text-xs text-muted tabular">
              {source.latest_run.records} collected · {source.latest_run.failures} failed
            </span>
          </>
        )}
      </td>
    </tr>
  );
}

/**
 * Rule 2. `Suspect` says the word and both numbers behind it.
 *
 * `unknown` is not `fine`. A source with no stated interval has had no
 * expectation set, and reporting that as healthy would be claiming a source is
 * fine because nobody said what fine meant.
 */
function SilenceCell({ source }: { source: PublicStatusSource }) {
  const { verdict, hours_since_success, expected_interval_hours } = source.silence;

  const detail = (
    <span className="mt-1 block text-xs text-ink-soft tabular">
      {hours_since_success === null
        ? "No successful sweep on record"
        : `${hours_since_success} h since last success`}
      {expected_interval_hours !== null && ` · expected every ${expected_interval_hours} h`}
    </span>
  );

  if (verdict === "suspect") {
    return (
      <>
        <span className="text-sm font-semibold text-accent">Suspect</span>
        {detail}
      </>
    );
  }

  if (verdict === "ok") {
    return (
      <>
        <span className="text-sm text-pass">Within interval</span>
        {detail}
      </>
    );
  }

  return (
    <>
      <span className="text-sm text-muted">Unknown</span>
      <span className="mt-1 block max-w-[14rem] text-xs leading-relaxed text-muted">
        No expected interval is set for this source, so silence here means nothing either way.
      </span>
    </>
  );
}
