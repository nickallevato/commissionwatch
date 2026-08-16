import { Link, useParams } from "react-router-dom";
import { useMatter } from "@/hooks/useMatters";
import type { MatterAppearance, MatterState } from "@/types";

/**
 * `/matters/:id` — one subject of decision, and every meeting that touched it.
 *
 * This is the page the rest of the archive was missing. A meeting page answers
 * "what did they do on the 12th"; this answers "what happened to this", which
 * is the question a person actually arrives with.
 *
 * The timeline reads forwards, oldest first, because that is the order events
 * happened in and a reader is following a story rather than checking for news.
 */

const STATE_SENTENCE: Record<MatterState, string> = {
  pending: "On the record and not yet decided.",
  decided: "A vote is recorded on its most recent appearance.",
  withdrawn: "The record says this was withdrawn.",
  dormant:
    "This last appeared some time ago and no decision is recorded. It has not been withdrawn — it simply has not returned.",
};

/**
 * Why two agenda items were treated as the same matter, said plainly.
 *
 * Shown on every appearance rather than hidden behind a tooltip: joining two
 * records is an assertion, and the reader is entitled to see the basis without
 * asking. There are only two bases and neither is fuzzy — a near-match would be
 * an inference, and this project does not publish inferences.
 */
const MATCH_RULE_LABEL: Record<MatterAppearance["match_rule"], string> = {
  designator: "matched on its file number",
  normalized_title: "matched on an identical title",
};

function AppearanceRow({ appearance }: { appearance: MatterAppearance }) {
  return (
    <li className="border-b border-rule py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm">
          <Link
            to={`/meetings/${appearance.meeting_id}`}
            className="font-medium hover:underline underline-offset-2"
          >
            <span className="figure">{appearance.meeting_date}</span>
          </Link>
          <span className="text-ink-soft">
            {" · item "}
            <span className="figure">{appearance.item_number}</span>
          </span>
        </p>
        <span className="label-sm whitespace-nowrap text-muted">
          {MATCH_RULE_LABEL[appearance.match_rule]}
        </span>
      </div>
      {/* The title as printed at *that* meeting. A body renaming an item between
          readings is the kind of thing this page exists to surface, so it is
          shown per appearance rather than normalised away. */}
      <p className="mt-1 text-sm leading-relaxed text-ink-soft">{appearance.title}</p>
    </li>
  );
}

export function MatterDetailPage() {
  const { id = "" } = useParams();
  const { data: matter, isLoading, isError } = useMatter(id);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="headline text-3xl">Matter</h1>
        <p className="mt-4 text-sm text-ink-soft" role="status" aria-live="polite">
          Loading…
        </p>
      </div>
    );
  }

  if (isError || !matter) {
    // 404 covers "no such matter" and "no published appearance" alike, and the
    // copy does not distinguish them — telling a stranger which one it was
    // would confirm that something exists and is being withheld.
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="headline text-3xl">Matter not found</h1>
        <p className="mt-4 max-w-prose text-sm leading-relaxed text-ink-soft">
          No published matter has this address. It may never have existed, or it
          may have no appearance on a meeting that has been published.
        </p>
        <p className="mt-4 text-sm">
          <Link to="/matters" className="underline underline-offset-2">
            Back to all matters
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <header>
        <p className="kicker">
          {matter.jurisdiction_name} · {matter.commission_name}
        </p>
        <h1 className="headline mt-1.5 text-3xl sm:text-4xl">
          {matter.designator ? (
            <>
              <span className="figure">{matter.designator}</span>
              <span className="text-ink-soft"> — </span>
            </>
          ) : null}
          {matter.title}
        </h1>
        <p className="mt-3 max-w-prose text-sm leading-relaxed text-ink-soft">
          {STATE_SENTENCE[matter.state]}
        </p>
      </header>

      <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-3 border-y border-rule py-3 sm:grid-cols-3">
        <div>
          <dt className="label-sm">First on an agenda</dt>
          <dd className="mt-0.5 text-sm figure">{matter.first_seen}</dd>
        </div>
        <div>
          <dt className="label-sm">Most recently</dt>
          <dd className="mt-0.5 text-sm figure">{matter.last_seen}</dd>
        </div>
        <div>
          <dt className="label-sm">Appearances</dt>
          <dd className="mt-0.5 text-sm figure">{matter.appearance_count}</dd>
        </div>
      </dl>

      <section className="mt-8" aria-labelledby="timeline">
        <h2 id="timeline" className="font-display text-xl tracking-headline">
          On the agenda
        </h2>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
          Every published meeting whose agenda carried this matter, oldest
          first. Meetings that have not been published are not listed and are
          not counted above.
        </p>
        {matter.appearances.length === 0 ? (
          <p className="mt-4 text-sm text-ink-soft">
            No published meeting carries this matter.
          </p>
        ) : (
          <ul className="mt-2">
            {matter.appearances.map((appearance) => (
              <AppearanceRow key={appearance.agenda_item_id} appearance={appearance} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
