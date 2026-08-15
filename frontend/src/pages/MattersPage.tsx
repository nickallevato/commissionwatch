import { useState } from "react";
import { Link } from "react-router-dom";
import { useMatters } from "@/hooks/useMatters";
import { Absence } from "@/components/ui/Absence";
import type { Matter, MatterState } from "@/types";

/**
 * `/matters` — what the body is deciding, rather than when it met.
 *
 * The archive is organised by meeting, which is how a clerk files it and not
 * how anyone asks about it. A resident asks "what is happening with the rezone
 * on Main Street", and until this page the only way to answer was to read every
 * agenda in order and hold the thread yourself.
 *
 * The state a reader most needs is the one nothing else can show: **dormant**.
 * An item that appeared three times and then stopped is invisible in an
 * event-shaped archive, because its defining feature is that nothing happened.
 */

const STATE_LABELS: Record<MatterState, string> = {
  pending: "Pending",
  decided: "Decided",
  withdrawn: "Withdrawn",
  dormant: "No recent activity",
};

/**
 * What each state means, in the reader's terms rather than the schema's.
 *
 * `dormant` gets the longest gloss because it is the only one that is an
 * absence, and an absence shown without explanation reads as a bug.
 */
const STATE_HINTS: Record<MatterState, string> = {
  pending: "On the record and not yet decided.",
  decided: "A vote is recorded on its most recent appearance.",
  withdrawn: "The record says it was withdrawn.",
  dormant: "Last appeared some time ago with no decision recorded. It may return.",
};

/**
 * `withdrawn` is a member of the type and is deliberately absent here.
 *
 * The API never derives it: nothing in the schema records a withdrawal, and
 * matching the word in a title mislabels "appeal of withdrawn permit". Offering
 * a filter that can only ever return nothing would say "no matters are
 * withdrawn", which is a claim — the truth is that we cannot tell. The detail
 * page still renders the state, so when `vote_events` supplies it with a quote
 * and an approval behind it, this list is the only thing that needs changing.
 */
const STATE_ORDER: MatterState[] = ["pending", "decided", "dormant"];

function StateTag({ state }: { state: MatterState }) {
  return (
    <span className="label-sm whitespace-nowrap text-muted">{STATE_LABELS[state]}</span>
  );
}

function MatterRow({ matter }: { matter: Matter }) {
  return (
    <li className="border-b border-rule py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-base font-medium leading-snug">
          <Link to={`/matters/${matter.id}`} className="hover:underline underline-offset-2">
            {matter.designator ? (
              <>
                <span className="figure">{matter.designator}</span>
                {" — "}
              </>
            ) : null}
            {matter.title}
          </Link>
        </h2>
        <StateTag state={matter.state} />
      </div>
      <p className="mt-1 text-sm text-ink-soft">
        {matter.commission_name}
        {" · "}
        <span className="figure">{matter.appearance_count}</span>{" "}
        {matter.appearance_count === 1 ? "appearance" : "appearances"}
        {" · "}
        <span className="figure">{matter.first_seen}</span>
        {matter.last_seen !== matter.first_seen ? (
          <>
            {" to "}
            <span className="figure">{matter.last_seen}</span>
          </>
        ) : null}
      </p>
    </li>
  );
}

export function MattersPage() {
  const [state, setState] = useState<"" | MatterState>("");
  const { data: matters, isLoading, isError } = useMatters(
    state ? { state } : {},
  );

  return (
    <div className="mx-auto max-w-3xl">
      <header>
        <p className="kicker">The record</p>
        <h1 className="headline mt-1.5 text-3xl sm:text-4xl">Matters</h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-soft">
          A matter is a subject a body is deciding — an ordinance, a rezone, a
          project — followed across every meeting that touched it. Agenda items
          are filed by meeting; this is the same record read the other way, so
          that an item tabled four times reads as one story rather than four.
        </p>
      </header>

      <div className="mt-6 flex flex-wrap items-end gap-x-6 gap-y-4 border-y border-rule py-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-state" className="label-sm">
            Status
          </label>
          <select
            id="filter-state"
            value={state}
            onChange={(event) => setState(event.target.value as "" | MatterState)}
            className="rounded-none border border-rule bg-paper px-2 py-1 text-sm text-ink focus:border-ink"
          >
            <option value="">All statuses</option>
            {STATE_ORDER.map((value) => (
              <option key={value} value={value}>
                {STATE_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        {state ? (
          <p className="max-w-prose text-xs leading-relaxed text-muted">
            {STATE_HINTS[state]}
          </p>
        ) : null}
      </div>

      {isLoading ? (
        <p className="mt-8 text-sm text-ink-soft">Loading matters…</p>
      ) : isError ? (
        /* A failure of ours, not an empty record — the distinction is the whole
           reason `<Absence>` exists. See its header. */
        <Absence reason="request-failed" subject="Matters" />
      ) : (matters ?? []).length === 0 ? (
        state ? (
          <Absence reason="none-exist" subject={`matters currently ${STATE_LABELS[state].toLowerCase()}`} />
        ) : (
          <Absence reason="not-yet-ingested" subject="matters" />
        )
      ) : (
        <ul className="mt-2">
          {(matters ?? []).map((matter) => (
            <MatterRow key={matter.id} matter={matter} />
          ))}
        </ul>
      )}
    </div>
  );
}
