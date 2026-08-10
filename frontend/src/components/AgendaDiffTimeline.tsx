import { useMemo } from "react";
import type {
  AgendaChange,
  AgendaChangeKind,
  AgendaDiffPair,
  DocumentTimeline,
  DocumentVersionSummary,
  VersionItem,
} from "@/types";

/**
 * P5 · What changed in a document, and how close to the vote.
 *
 * Two things this component is careful about, both of them editorial rather
 * than technical.
 *
 * **One version is the common case and is not a failure.** Most documents are
 * published once and never revised. That renders as a single calm line stating
 * when it was first seen — not as an empty two-column comparison, and not as a
 * "no changes" badge, which would be a claim about a comparison that never
 * happened.
 *
 * **The record, never the motive.** Every string here is a fact about two
 * documents: what they contained, and when each was first seen. Nothing
 * suggests why an item appeared, and the timing is stated as arithmetic
 * ("19 hours before the scheduled start") rather than as a characterisation.
 */

/* ------------------------------------------------------------- formatting */

function formatSeen(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** The first twelve hex characters. Enough to cite, short enough to read. */
function shortHash(sha256: string): string {
  return sha256.slice(0, 12);
}

function summarise(changes: AgendaChange[]): string {
  const counts: Record<AgendaChangeKind, number> = { added: 0, removed: 0, retitled: 0 };
  for (const change of changes) counts[change.kind] += 1;
  const parts: string[] = [];
  const label = (n: number, word: string): string => `${n} ${n === 1 ? "item" : "items"} ${word}`;
  if (counts.added > 0) parts.push(label(counts.added, "added"));
  if (counts.removed > 0) parts.push(label(counts.removed, "removed"));
  if (counts.retitled > 0) parts.push(label(counts.retitled, "retitled"));
  return parts.length > 0 ? parts.join(", ") : "No change to the extracted items";
}

/* ------------------------------------------------------------ item marking */

type Mark = "added" | "removed" | "retitled" | "unchanged";

const markLabel: Record<Mark, string> = {
  added: "Added",
  removed: "Removed",
  retitled: "Retitled",
  unchanged: "Unchanged",
};

/**
 * `text-accent` is the project's single red and is reserved for what changed.
 * An unchanged item is `muted`, so the eye lands on the difference without a
 * second colour being invented for the purpose.
 */
const markClass: Record<Mark, string> = {
  added: "text-accent",
  removed: "text-accent",
  retitled: "text-accent",
  unchanged: "text-muted",
};

function normalize(title: string): string {
  return title.replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

/**
 * Marks one side's items against the change list.
 *
 * The two columns are each the agenda as published, in its own order, rather
 * than a synthesised row-by-row alignment. An alignment would have to invent
 * pairings the backend deliberately declined to infer.
 */
function markSide(
  items: VersionItem[],
  changes: AgendaChange[],
  side: "from" | "to",
): Array<{ item: VersionItem; mark: Mark }> {
  const changedTitles = new Map<string, Mark>();
  for (const change of changes) {
    if (change.kind === "retitled") {
      const title = side === "to" ? change.title : (change.previous_title ?? change.title);
      changedTitles.set(normalize(title), "retitled");
      continue;
    }
    if (side === "to" && change.kind === "added") {
      changedTitles.set(normalize(change.title), "added");
    }
    if (side === "from" && change.kind === "removed") {
      changedTitles.set(normalize(change.title), "removed");
    }
  }
  return items.map((item) => ({
    item,
    mark: changedTitles.get(normalize(item.title)) ?? "unchanged",
  }));
}

/* ------------------------------------------------------------------ pieces */

function VersionHeading({
  version,
  role,
}: {
  version: DocumentVersionSummary;
  role: "Earlier version" | "Later version";
}) {
  return (
    <div className="border-b border-ink pb-2">
      <span className="kicker">{role}</span>
      <p className="font-sans text-sm font-semibold text-ink">
        Version <span className="figure">{version.version_no}</span>
      </p>
      <p className="mt-0.5 text-xs text-muted">First seen {formatSeen(version.first_seen_at)}</p>
      <p className="figure mt-0.5 text-[11px] text-muted" title={version.sha256}>
        sha256 {shortHash(version.sha256)}…
      </p>
    </div>
  );
}

function ItemColumn({
  items,
  changes,
  side,
}: {
  items: VersionItem[] | null;
  changes: AgendaChange[];
  side: "from" | "to";
}) {
  if (items === null) {
    // Never an empty column: "we did not extract this" and "this agenda had no
    // items" are different statements about the public record.
    return (
      <p className="mt-3 text-sm text-muted">
        Items were not extracted from this version. The document is stored and citable.
      </p>
    );
  }
  if (items.length === 0) {
    return <p className="mt-3 text-sm text-muted">No agenda items were extracted.</p>;
  }
  const marked = markSide(items, changes, side);
  return (
    <ol className="mt-3 space-y-2">
      {marked.map(({ item, mark }) => (
        <li key={`${item.item_number}-${item.title}`} className="flex gap-2 text-sm">
          <span className="figure w-6 shrink-0 text-xs text-muted">{item.item_number}</span>
          <span className="min-w-0">
            <span className={mark === "unchanged" ? "text-ink-soft" : "text-ink"}>
              {item.title}
            </span>
            {mark !== "unchanged" && (
              <span className={`label-sm ml-2 ${markClass[mark]}`}>{markLabel[mark]}</span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

function DiffPair({ pair }: { pair: AgendaDiffPair }) {
  const changes = pair.changes;
  return (
    <article className="mt-6 border-t border-rule pt-4">
      {changes === null ? (
        <p className="max-w-prose text-sm text-muted">
          Version <span className="figure">{pair.to.version_no}</span> was first seen{" "}
          {formatSeen(pair.to.first_seen_at)}. The items of at least one of these versions were
          never extracted, so no comparison is offered.
        </p>
      ) : (
        <p className="max-w-prose text-sm text-ink-soft">
          Between version <span className="figure">{pair.from.version_no}</span> and version{" "}
          <span className="figure">{pair.to.version_no}</span>, first seen{" "}
          {formatSeen(pair.to.first_seen_at)}: {summarise(changes)}.
        </p>
      )}

      <div className="mt-4 grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2">
        <div>
          <VersionHeading version={pair.from} role="Earlier version" />
          <ItemColumn items={pair.from_items} changes={changes ?? []} side="from" />
        </div>
        <div>
          <VersionHeading version={pair.to} role="Later version" />
          <ItemColumn items={pair.to_items} changes={changes ?? []} side="to" />
        </div>
      </div>
    </article>
  );
}

function SingleVersion({ version }: { version: DocumentVersionSummary }) {
  return (
    <p className="mt-2 max-w-prose text-sm text-muted">
      One version on file, first seen {formatSeen(version.first_seen_at)}
      {version.item_count === null
        ? ". Its items were not extracted"
        : `, with ${version.item_count} ${version.item_count === 1 ? "item" : "items"} extracted`}
      .{" "}
      <span className="figure text-[11px]" title={version.sha256}>
        sha256 {shortHash(version.sha256)}…
      </span>
    </p>
  );
}

function DocumentSection({ timeline }: { timeline: DocumentTimeline }) {
  const latestFirst = useMemo(() => [...timeline.diffs].reverse(), [timeline.diffs]);
  const only = timeline.versions.length === 1 ? timeline.versions[0] : undefined;

  return (
    <section className="mt-8 first:mt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-sans text-base font-semibold text-ink">
          <a
            href={timeline.url}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-accent"
          >
            {timeline.title}
          </a>
        </h3>
        <span className="label-sm">
          {timeline.versions.length}{" "}
          {timeline.versions.length === 1 ? "version" : "versions"} on file
        </span>
      </div>

      {only ? (
        <SingleVersion version={only} />
      ) : (
        latestFirst.map((pair) => <DiffPair key={`${pair.from.id}-${pair.to.id}`} pair={pair} />)
      )}
    </section>
  );
}

/* -------------------------------------------------------------------- page */

export interface AgendaDiffTimelineProps {
  timelines: DocumentTimeline[] | undefined;
  isLoading: boolean;
  isError: boolean;
}

export function AgendaDiffTimeline({ timelines, isLoading, isError }: AgendaDiffTimelineProps) {
  if (isLoading) {
    return (
      <section aria-labelledby="versions-heading" className="mt-10">
        <TimelineHeading />
        <div className="mt-4 space-y-3" aria-hidden="true">
          {[0, 1].map((row) => (
            <div key={row} className="h-10 animate-pulse bg-paper-sunk" />
          ))}
        </div>
      </section>
    );
  }

  if (isError) {
    return (
      <section aria-labelledby="versions-heading" className="mt-10">
        <TimelineHeading />
        <p className="mt-4 text-sm text-muted">
          The version history for this meeting could not be loaded.
        </p>
      </section>
    );
  }

  if (!timelines || timelines.length === 0) {
    return (
      <section aria-labelledby="versions-heading" className="mt-10">
        <TimelineHeading />
        <p className="mt-4 text-sm text-muted">
          No stored versions on file for this meeting&rsquo;s documents.
        </p>
      </section>
    );
  }

  const revised = timelines.filter((timeline) => timeline.versions.length > 1).length;

  return (
    <section aria-labelledby="versions-heading" className="mt-10">
      <TimelineHeading />
      <p className="mt-2 max-w-prose text-sm text-muted">
        {revised === 0
          ? "Every document on this meeting has been published once. Nothing was revised after it first appeared."
          : `${revised} of ${timelines.length} documents on this meeting were republished after first appearing. Each comparison below is between the agenda items extracted from two stored copies.`}
      </p>
      {timelines.map((timeline) => (
        <DocumentSection key={timeline.document_id} timeline={timeline} />
      ))}
    </section>
  );
}

function TimelineHeading() {
  return (
    <>
      <div className="rule-hi" />
      <div className="pt-3">
        <span className="kicker">Document history</span>
        <h2
          id="versions-heading"
          className="font-display text-2xl leading-headline tracking-headline text-ink"
        >
          What changed, and when
        </h2>
      </div>
    </>
  );
}
