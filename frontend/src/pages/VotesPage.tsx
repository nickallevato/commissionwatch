import { Fragment, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { useVotes } from "@/hooks/useVotes";
import { agendaItemsQuery, useMeetings } from "@/hooks/useMeetings";
import { useMembers } from "@/hooks/useMembers";
import {
  VoteBreakdown,
  VOTE_LABEL,
  VOTE_ORDER,
  tallyVotes,
  type VoteTally,
} from "@/components/VoteBreakdown";
import type { AgendaItem, Vote } from "@/types";

const controlClass =
  "border border-rule bg-paper px-2 py-1 text-sm text-ink hover:border-ink";

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

/**
 * Format a `YYYY-MM-DD` date without going through `new Date()`, so a
 * date-only column never slips a day in a negative-offset timezone.
 */
function formatRecordDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const [, year, month, day] = match;
  return `${MONTHS[Number(month) - 1]} ${Number(day)}, ${year}`;
}

/** Flatten the per-meeting agenda-item queries into one list. */
function combineAgendaItems(
  results: { data: AgendaItem[] | undefined }[],
): AgendaItem[] {
  return results.flatMap((r) => r.data ?? []);
}

/** One decision: every vote cast on a single agenda item at a single meeting. */
interface VoteRecord {
  key: string;
  date: string;
  meetingId: string;
  meetingLabel: string;
  jurisdictionId: string;
  jurisdictionLabel: string;
  itemTitle: string;
  counts: VoteTally;
  votes: Vote[];
  passed: boolean;
}

export function VotesPage() {
  const [jurisdictionId, setJurisdictionId] = useState("");
  const [result, setResult] = useState("");
  const [search, setSearch] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);

  const { data: votes, isLoading, isError } = useVotes();
  const { data: meetings } = useMeetings();
  const { data: members } = useMembers();

  const meetingIds = useMemo(
    () => Array.from(new Set((votes ?? []).map((v) => v.meeting_id))).sort(),
    [votes],
  );

  // Agenda items are served per meeting, so fetch one query per meeting that
  // actually has votes. The query keys match `useAgendaItems`, so a visit to a
  // meeting page reuses the same cache entry.
  const agendaItems = useQueries({
    queries: meetingIds.map(agendaItemsQuery),
    combine: combineAgendaItems,
  });

  const records = useMemo<VoteRecord[]>(() => {
    const meetingById = new Map((meetings ?? []).map((m) => [m.id, m]));
    const itemById = new Map(agendaItems.map((item) => [item.id, item]));

    const groups = new Map<string, Vote[]>();
    for (const vote of votes ?? []) {
      const key = `${vote.meeting_id}::${vote.agenda_item_id ?? "meeting"}`;
      const existing = groups.get(key);
      if (existing) existing.push(vote);
      else groups.set(key, [vote]);
    }

    const out: VoteRecord[] = [];
    for (const [key, group] of groups) {
      const first = group[0];
      const meeting = meetingById.get(first.meeting_id);
      const item = first.agenda_item_id
        ? itemById.get(first.agenda_item_id)
        : undefined;
      const jurisdiction = meeting?.commission?.jurisdiction;
      const counts = tallyVotes(group);

      out.push({
        key,
        date: meeting?.date ?? first.created_at.slice(0, 10),
        meetingId: first.meeting_id,
        meetingLabel: meeting?.commission?.name ?? "Commission meeting",
        jurisdictionId: jurisdiction?.id ?? "",
        jurisdictionLabel: jurisdiction
          ? `${jurisdiction.name}, ${jurisdiction.state}`
          : "Jurisdiction unrecorded",
        itemTitle: item?.title ?? "Motion recorded without an agenda item",
        counts,
        votes: group,
        passed: counts.yes > counts.no,
      });
    }

    out.sort((a, b) =>
      a.date === b.date
        ? a.itemTitle.localeCompare(b.itemTitle)
        : b.date.localeCompare(a.date),
    );
    return out;
  }, [votes, meetings, agendaItems]);

  const jurisdictionOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const record of records) {
      if (record.jurisdictionId) {
        map.set(record.jurisdictionId, record.jurisdictionLabel);
      }
    }
    return Array.from(map, ([id, label]) => ({ id, label })).sort((a, b) =>
      a.label.localeCompare(b.label),
    );
  }, [records]);

  const needle = search.trim().toLowerCase();
  const filtered = records.filter((record) => {
    if (jurisdictionId && record.jurisdictionId !== jurisdictionId) return false;
    if (result === "passed" && !record.passed) return false;
    if (result === "failed" && record.passed) return false;
    if (
      needle &&
      !record.itemTitle.toLowerCase().includes(needle) &&
      !record.meetingLabel.toLowerCase().includes(needle)
    ) {
      return false;
    }
    return true;
  });

  const filtersActive = Boolean(jurisdictionId || result || search);

  return (
    <div>
      <header>
        <p className="kicker">The record</p>
        <h2 className="headline mt-1">Votes</h2>
        <p className="mt-3 max-w-xl text-sm text-muted">
          Every recorded decision, item by item, with the tally as it was cast
          and the outcome that followed.
        </p>
      </header>

      <div className="rule-hi mt-6" />

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-rule py-3">
        <label className="flex items-center gap-2">
          <span className="label-sm">Jurisdiction</span>
          <select
            value={jurisdictionId}
            onChange={(e) => setJurisdictionId(e.target.value)}
            className={controlClass}
          >
            <option value="">All jurisdictions</option>
            {jurisdictionOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2">
          <span className="label-sm">Result</span>
          <select
            value={result}
            onChange={(e) => setResult(e.target.value)}
            className={controlClass}
          >
            <option value="">All results</option>
            <option value="passed">Passed</option>
            <option value="failed">Failed</option>
          </select>
        </label>

        <label className="flex items-center gap-2">
          <span className="label-sm">Search</span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Item or commission"
            className={controlClass}
          />
        </label>

        {filtersActive && (
          <button
            type="button"
            onClick={() => {
              setJurisdictionId("");
              setResult("");
              setSearch("");
            }}
            className="label-sm underline underline-offset-4 hover:text-ink"
          >
            Clear
          </button>
        )}

        <p className="label-sm ml-auto">
          <span className="figure text-sm text-ink">{filtered.length}</span>{" "}
          {filtered.length === 1 ? "record" : "records"}
        </p>
      </div>

      {isLoading ? (
        <div role="status" aria-live="polite">
          <span className="sr-only">Loading the vote record</span>
          {[1, 2, 3].map((i) => (
            <div key={i} className="border-b border-rule py-4">
              <div className="h-4 w-full animate-pulse bg-paper-sunk" />
            </div>
          ))}
        </div>
      ) : isError ? (
        <p className="border-b border-rule py-12 text-center text-sm text-accent">
          The vote record could not be loaded.
        </p>
      ) : filtered.length === 0 ? (
        <p className="border-b border-rule py-12 text-center text-sm text-muted">
          No vote records match these filters.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[54rem] border-collapse text-left">
            <caption className="sr-only">Recorded votes</caption>
            <thead>
              <tr className="border-b border-ink">
                <th scope="col" className="py-2 pr-4">
                  <span className="label-sm">Date</span>
                </th>
                <th scope="col" className="py-2 pr-4">
                  <span className="label-sm">Meeting</span>
                </th>
                <th scope="col" className="py-2 pr-4">
                  <span className="label-sm">Item</span>
                </th>
                {VOTE_ORDER.map((value) => (
                  <th key={value} scope="col" className="px-2 py-2 text-right">
                    <span className="label-sm">{VOTE_LABEL[value]}</span>
                  </th>
                ))}
                <th scope="col" className="py-2 pl-4 text-right">
                  <span className="label-sm">Result</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((record) => {
                const open = openKey === record.key;
                return (
                  <Fragment key={record.key}>
                    <tr className="border-b border-rule align-top">
                      <td className="whitespace-nowrap py-3 pr-4">
                        <span className="figure text-xs text-muted">
                          {formatRecordDate(record.date)}
                        </span>
                      </td>
                      <td className="py-3 pr-4">
                        <p className="text-sm text-ink-soft">
                          {record.meetingLabel}
                        </p>
                        <p className="mt-0.5 text-xs text-muted">
                          {record.jurisdictionLabel}
                        </p>
                      </td>
                      <td className="py-3 pr-4">
                        <button
                          type="button"
                          aria-expanded={open}
                          onClick={() => setOpenKey(open ? null : record.key)}
                          className="text-left font-display text-base leading-snug text-ink underline-offset-4 hover:underline"
                        >
                          {record.itemTitle}
                        </button>
                      </td>
                      {VOTE_ORDER.map((value) => (
                        <td key={value} className="px-2 py-3 text-right">
                          <span
                            className={`figure text-sm ${
                              record.counts[value] > 0
                                ? "text-ink"
                                : "text-muted"
                            }`}
                          >
                            {record.counts[value]}
                          </span>
                        </td>
                      ))}
                      <td className="py-3 pl-4 text-right">
                        <span
                          className={`text-[0.6875rem] font-semibold uppercase tracking-label ${
                            record.passed ? "text-pass" : "text-fail"
                          }`}
                        >
                          {record.passed ? "Passed" : "Failed"}
                        </span>
                      </td>
                    </tr>
                    {open && (
                      <tr className="border-b border-rule">
                        <td
                          colSpan={4 + VOTE_ORDER.length}
                          className="bg-paper-sunk px-3 py-4"
                        >
                          <VoteBreakdown
                            mode="roll-call"
                            votes={record.votes}
                            members={members ?? []}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
