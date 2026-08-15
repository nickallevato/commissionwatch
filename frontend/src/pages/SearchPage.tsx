import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useSearch, splitSnippet } from "@/hooks/useSearch";
import type { SearchResult } from "@/types";

/**
 * P6 · Search over the published record.
 *
 * The query lives in the URL, so a search is linkable and the back button does
 * what a reader expects. The box holds a draft until submit; typing does not
 * fire a request per keystroke at a county's archive.
 *
 * Two sentences on this page are load-bearing and are not there for tone:
 *
 * - Zero results says **"No published record matches"**. On a site with a review
 *   queue, "nothing found" and "nothing published" are different statements, and
 *   only one of them is true.
 * - The note under the box says only agenda text that has been read is
 *   searchable. Minutes and packets are stored, cited and *not* extracted, so a
 *   reader who finds nothing should know whether that is the record or the
 *   pipeline.
 */

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** `YYYY-MM-DD` in UTC, so a date-only value never slides a day west of Greenwich. */
function formatDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const [, year, month, day] = match;
  return `${MONTHS[Number(month) - 1]} ${Number(day)}, ${year}`;
}

/**
 * `Record<SearchResult["kind"], string>` rather than a partial map, so widening
 * the union breaks here rather than rendering `undefined` as a label.
 *
 * That is not hypothetical: search grew `finding` and `matter` on the backend
 * while these four sat unchanged, and the two new kinds would have arrived with
 * no label and fallen through `hrefOf` to the officials roster — a matter about
 * Ordinance 2145 linking to a list of people. The compiler found all three
 * places the moment the union was corrected.
 */
const KIND_LABEL: Record<SearchResult["kind"], string> = {
  agenda_item: "Agenda item",
  meeting: "Meeting",
  member: "Official",
  document: "Document",
  finding: "Finding",
  matter: "Matter",
};

/** Where a result leads, or `null` for a record with no page of its own. */
function hrefOf(result: SearchResult): string | null {
  switch (result.kind) {
    case "agenda_item":
    case "meeting":
    case "document":
      return `/meetings/${result.meeting_id}`;
    case "member":
      // There is no per-official page yet. The roster is the honest destination;
      // linking at a route that does not exist would render a 404 inside the
      // site chrome and read as a broken record rather than a missing page.
      //
      // `/officials`, not `/members` — the latter is a 301 since the vocabulary
      // rename, and pointing a search result at a redirect costs the reader a
      // hop and a crawler a fetch for nothing.
      return "/officials";
    case "matter":
      return `/matters/${result.id}`;
    case "finding":
      // A records-derived finding has no meeting — `meeting_id` is nullable and
      // this is the branch that respects it. Linking `/meetings/null` is the
      // failure a non-null assertion would have produced.
      return result.meeting_id === null ? "/findings" : `/meetings/${result.meeting_id}`;
  }
}

/** The dateline under a result: who, where, when — whichever the record carries. */
function datelineOf(result: SearchResult): string {
  switch (result.kind) {
    case "agenda_item":
      return `Item ${result.item_number} · ${result.commission_name} · ${formatDate(
        result.meeting_date,
      )}`;
    case "meeting":
      return `${result.jurisdiction_name} · ${formatDate(result.meeting_date)}`;
    case "member":
      return result.jurisdiction_name;
    case "document":
      return `${result.commission_name} · ${formatDate(result.meeting_date)}`;
    case "finding":
      // Severity and type, not a date: a finding's dateline is what kind of
      // thing it is, and the flag type is stored snake_case.
      return `${result.severity} · ${result.flag_type.replace(/_/g, " ")}`;
    case "matter":
      // The designator is what a reader recognises — "Ordinance 2145" is how
      // the matter is referred to in the room — so it leads when there is one.
      return result.designator
        ? `${result.designator} · ${result.commission_name}`
        : `${result.commission_name} · ${result.jurisdiction_name}`;
  }
}

/**
 * The matching passage, with matches marked.
 *
 * The API delimits matches with control characters precisely so this can build
 * elements instead of injecting HTML — the text came out of third-party PDFs.
 */
function Snippet({ snippet }: { snippet: string }) {
  const segments = splitSnippet(snippet);
  if (segments.length === 0) return null;
  return (
    <p className="mt-1 text-[0.8125rem] leading-relaxed text-ink-soft">
      {segments.map((segment, index) =>
        segment.match ? (
          <mark key={index} className="bg-accent-100 text-ink">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </p>
  );
}

function ResultRow({ result }: { result: SearchResult }) {
  const href = hrefOf(result);
  const body = (
    <>
      <p className="kicker text-muted">{KIND_LABEL[result.kind]}</p>
      {/* h2, not h3: the page heading is now the h1, and a result sits
          directly under it with no section heading in between, so h3 would
          skip a level. Visual size is set by the classes, not by the tag. */}
      <h2 className="font-display text-lg font-semibold leading-snug tracking-headline text-ink underline-offset-4 group-hover:underline">
        {result.title}
      </h2>
      <p className="tabular mt-1 text-[0.8125rem] leading-normal text-muted">
        {datelineOf(result)}
      </p>
      <Snippet snippet={result.snippet} />
    </>
  );

  return (
    <article aria-label={result.title} className="border-b border-rule">
      {href === null ? (
        <div className="py-5">{body}</div>
      ) : (
        <Link to={href} className="group block py-5">
          {body}
        </Link>
      )}
    </article>
  );
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const [draft, setDraft] = useState(query);

  const { data, isLoading, isError } = useSearch(query);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = draft.trim();
    // `replace` so a reader who refines a query three times does not have to
    // press back three times to leave the page.
    setParams(next.length > 0 ? { q: next } : {}, { replace: true });
  }

  return (
    <div>
      <header>
        <p className="kicker">The archive</p>
        <h1 className="headline mt-1">Search</h1>
        <p className="mt-3 max-w-xl text-sm text-muted">
          Every published agenda item, meeting, official and extracted document
          text we hold. Quote a phrase to match it exactly, and prefix a word
          with a minus to exclude it.
        </p>
      </header>

      <div className="rule-hi mt-6" />

      <form
        onSubmit={onSubmit}
        role="search"
        className="flex flex-wrap items-center gap-3 border-b border-rule py-4"
      >
        <label htmlFor="search-q" className="label-sm">
          Search the record
        </label>
        <input
          id="search-q"
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder='e.g. zoning variance, "capital improvement plan", budget -consent'
          className="min-w-0 flex-1 rounded-none border border-rule bg-paper px-3 py-2 text-sm text-ink placeholder:text-muted hover:border-ink focus:border-ink"
        />
        <button
          type="submit"
          className="border border-ink px-4 py-2 text-[11px] font-semibold uppercase tracking-label text-ink hover:bg-ink hover:text-paper"
        >
          Search
        </button>
        {data && query !== "" && (
          <p className="label-sm ml-auto">
            <span className="figure text-sm text-ink">{data.total}</span>{" "}
            {data.total === 1 ? "result" : "results"}
          </p>
        )}
      </form>

      {/* The query is the subscription.
        
        This is the only place a reader learns that, and without it the query
        feed is a channel nobody can find: there is no account to attach a saved
        search to and no settings page to put one on, by design. The URL *is*
        the subscription — it holds nothing about who subscribed, there is
        nothing to leak and nothing to unsubscribe from, and it costs us no
        record of who is watching which official.
        
        A plain <a>, not a Link: /feed.xml is served by the backend and is not a
        route in this app, so client-side navigation would 404 inside the SPA. */}
      {query !== "" && (
        <p className="mt-3 text-xs text-muted">
          <a
            href={`/feed.xml?q=${encodeURIComponent(query)}`}
            className="underline underline-offset-2 hover:text-ink"
          >
            Subscribe to this search
          </a>{" "}
          — a feed of anything new that matches. No account, and we keep no
          record of who is subscribed.
        </p>
      )}

      {query === "" ? (
        <p className="border-b border-rule py-12 text-center text-sm text-muted">
          Enter a term to search the published record.
        </p>
      ) : isError ? (
        <p className="border-b border-rule py-12 text-center text-sm text-accent">
          The search could not be completed.
        </p>
      ) : isLoading ? (
        <div role="status" aria-live="polite">
          <span className="sr-only">Searching</span>
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="animate-pulse border-b border-rule py-5"
              aria-hidden="true"
            >
              <div className="h-5 w-64 max-w-full bg-paper-sunk" />
              <div className="mt-2 h-3 w-48 max-w-full bg-paper-sunk" />
            </div>
          ))}
        </div>
      ) : data && data.data.length > 0 ? (
        <div>
          {data.data.map((result) => (
            <ResultRow key={`${result.kind}:${result.id}`} result={result} />
          ))}
        </div>
      ) : (
        <p className="border-b border-rule py-12 text-center text-sm text-muted">
          No published record matches that search.
        </p>
      )}

      {/* A reader who finds nothing deserves to know whether that is the record
          or the pipeline. Minutes and packets are stored and citable; only
          agendas are read into text, so only agendas are searchable by body. */}
      <p className="mt-6 max-w-prose text-xs leading-relaxed text-muted">
        Only records an operator has published are searchable. Document text
        covers agendas that have been read into text — minutes and agenda packets
        are stored and citable, but their contents are not yet indexed.
      </p>
    </div>
  );
}
