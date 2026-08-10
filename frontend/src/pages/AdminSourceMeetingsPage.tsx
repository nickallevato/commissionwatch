import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ACTION,
  ACTION_PRIMARY,
  ACTION_QUIET,
  ACTION_ROW,
  ACTION_SMALL,
  FlagBar,
  FOCUS_RING,
  StatusPill,
  Tile,
  Tiles,
  WorkTitle,
} from "@/components/PressroomUI";
import type {
  BulkPublishResult,
  PressroomMeetingList,
  PressroomMeetingSummary,
} from "@/types";

/**
 * `/admin/sources/:id/meetings` — the gate between ingested and public.
 *
 * Migration 030 made `ingested` and `published` different states, which was
 * right and left this screen missing. A sweep produces candidates; only an
 * operator produces publications. Until now the console could open one meeting
 * by id and had nowhere to *find* an id, so the only path from a sweep to the
 * public site was knowing a UUID. For a source like Bozeman, whose Granicus
 * page carries 2013–2026 in a single document, that is not a path at all.
 *
 * Two things this screen refuses to do:
 *
 * 1. **Publish by filter.** The request carries explicit ids. A
 *    publish-everything-matching route would let a filter that drifted between
 *    this screen and the server publish records nobody looked at.
 * 2. **Pretend the page is the backlog.** `unpublished_total` is counted
 *    independently of the page size, so the tile says 512 when 100 are shown
 *    rather than implying the queue is exactly what fits.
 */

type Filter = "unpublished" | "published" | "all";

const FILTER_QUERY: Record<Filter, string> = {
  unpublished: "?published=false",
  published: "?published=true",
  all: "",
};

const FILTER_LABEL: Record<Filter, string> = {
  unpublished: "Awaiting review",
  published: "Published",
  all: "All",
};

export function AdminSourceMeetingsPage() {
  const { id = "" } = useParams<{ id: string }>();

  const [filter, setFilter] = useState<Filter>("unpublished");
  const [list, setList] = useState<PressroomMeetingList | null>(null);
  /**
   * The filter the loaded list belongs to.
   *
   * `loading` is derived from this rather than held as its own state, because
   * setting it inside the effect is a `react-hooks/set-state-in-effect` error —
   * and that rule is a CI gate here, not a style note. Deriving it also removes
   * the window where a switched filter shows the previous filter's rows as
   * settled data.
   */
  const [loadedFor, setLoadedFor] = useState<Filter | "">("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [reason, setReason] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async (): Promise<PressroomMeetingList | null> => {
    try {
      const res = await fetch(
        `/api/admin/pressroom/sources/${id}/meetings${FILTER_QUERY[filter]}`,
        { credentials: "same-origin" },
      );
      if (!res.ok) return null;
      return (await res.json()) as PressroomMeetingList;
    } catch {
      return null;
    }
  }, [id, filter]);

  useEffect(() => {
    let ignore = false;
    void (async () => {
      const result = await load();
      if (ignore) return;
      if (result === null) {
        setError("The ingested meetings for this source could not be loaded.");
      } else {
        setList(result);
        setError("");
        // Selection is dropped whenever the underlying set changes. Carrying a
        // tick across a reload would let an operator publish a row they can no
        // longer see.
        setSelected(new Set());
      }
      setLoadedFor(filter);
    })();
    return () => {
      ignore = true;
    };
  }, [load, filter]);

  const loading = loadedFor !== filter;
  const meetings = useMemo(() => list?.meetings ?? [], [list]);
  const selectable = useMemo(
    () => meetings.filter((meeting) => meeting.published_at === null),
    [meetings],
  );
  const allSelected = selectable.length > 0 && selected.size === selectable.length;

  function toggleOne(meetingId: string) {
    setNotice("");
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(meetingId)) next.delete(meetingId);
      else next.add(meetingId);
      return next;
    });
  }

  function toggleAll() {
    setNotice("");
    setSelected(allSelected ? new Set() : new Set(selectable.map((meeting) => meeting.id)));
  }

  async function handlePublish() {
    setPublishing(true);
    setNotice("");
    try {
      const res = await fetch("/api/admin/pressroom/meetings/publish", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meeting_ids: [...selected], reason }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setNotice(body?.error ?? "Nothing was published.");
        return;
      }

      const result = (await res.json()) as BulkPublishResult;
      // Every outcome is reported, including the two that are not failures.
      // "Published 12" when 3 were already live is a sentence that quietly
      // misleads the person who has to answer for the record.
      const parts = [`Published ${result.published.length}`];
      if (result.already_published.length > 0) {
        parts.push(`${result.already_published.length} were already public`);
      }
      if (result.not_found.length > 0) {
        parts.push(`${result.not_found.length} matched no meeting`);
      }
      setNotice(`${parts.join(" · ")}.`);
      setReason("");

      const refreshed = await load();
      if (refreshed !== null) setList(refreshed);
      setSelected(new Set());
    } catch {
      setNotice("The publish request could not be sent.");
    } finally {
      setPublishing(false);
    }
  }

  const backlog = list?.unpublished_total ?? 0;

  return (
    <>
      <WorkTitle
        title="Ingested meetings"
        stamp={
          loading ? "loading…" : `${meetings.length} shown · ${backlog} awaiting review`
        }
      />

      <p className="max-w-prose text-sm leading-relaxed text-ink-soft">
        A sweep produces candidates. Publication is a separate decision with a
        reason on it, and until it is made the public site cannot see these
        records at all — an unpublished meeting 404s rather than 403s, so nobody
        can enumerate what has been ingested and withheld.
      </p>

      <p className="text-[12px]">
        <Link
          to="/admin/sources"
          className={`text-muted underline decoration-rule underline-offset-4 hover:text-ink hover:decoration-accent ${FOCUS_RING}`}
        >
          ← All sources
        </Link>
      </p>

      {error && (
        <p role="alert" className="border-l-2 border-accent bg-accent-50 px-4 py-3 text-sm text-ink-soft">
          {error}
        </p>
      )}

      {notice && (
        <p role="status" className="border-l-2 border-ink bg-paper-sunk px-4 py-3 text-sm text-ink-soft">
          {notice}
        </p>
      )}

      <Tiles>
        <Tile
          label="Awaiting review"
          value={backlog}
          tone={backlog > 0 ? "warn" : "good"}
          sub={backlog > 0 ? "not visible to the public" : "nothing held"}
          testId="tile-backlog"
        />
        <Tile label="Shown on this page" value={meetings.length} sub={FILTER_LABEL[filter]} />
        <Tile label="Selected" value={selected.size} sub="will be published" testId="tile-selected" />
      </Tiles>

      <div className={ACTION_ROW}>
        {(["unpublished", "published", "all"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setFilter(option)}
            aria-pressed={filter === option}
            className={`${filter === option ? ACTION_PRIMARY : ACTION_QUIET} ${ACTION_SMALL} ${FOCUS_RING}`}
          >
            {FILTER_LABEL[option]}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="label-sm" role="status">
          Loading meetings…
        </p>
      ) : error !== "" ? null : meetings.length === 0 ? (
        // Guarded on `error`: a failed load also has zero rows, and telling the
        // operator "nothing is awaiting review" when the truth is "you cannot
        // see the queue" is the more dangerous of the two sentences.
        <p className="text-sm text-ink">
          {filter === "unpublished"
            ? "Nothing is awaiting review. Either everything ingested has been published, or nothing has been ingested."
            : "No meeting matches this filter."}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto border border-rule">
            <table className="w-full min-w-[48rem] border-collapse text-left text-[13px]">
              <caption className="sr-only">
                Meetings ingested from this source, with their publication state
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="label-sm border-b border-rule px-3 py-2">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleAll}
                        disabled={selectable.length === 0}
                        aria-label="Select every unpublished meeting shown"
                        data-testid="select-all"
                      />
                      <span className="sr-only">Select</span>
                    </label>
                  </th>
                  <th scope="col" className="label-sm border-b border-rule px-3 py-2">Date</th>
                  <th scope="col" className="label-sm border-b border-rule px-3 py-2">Body</th>
                  <th scope="col" className="label-sm border-b border-rule px-3 py-2">Documents</th>
                  <th scope="col" className="label-sm border-b border-rule px-3 py-2">State</th>
                  <th scope="col" className="label-sm border-b border-rule px-3 py-2">Record</th>
                </tr>
              </thead>
              <tbody>
                {meetings.map((meeting) => (
                  <MeetingRow
                    key={meeting.id}
                    meeting={meeting}
                    checked={selected.has(meeting.id)}
                    onToggle={() => toggleOne(meeting.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <form
            className="flex flex-wrap items-end gap-3 border border-rule bg-paper-sunk px-4 py-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (selected.size > 0 && reason.trim() !== "" && !publishing) void handlePublish();
            }}
          >
            <span className="block grow">
              <label htmlFor="publish-reason" className="label-sm block">
                Why are these records being published?
              </label>
              <input
                id="publish-reason"
                type="text"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Reviewed against the source listing; dates and agenda links match."
                className={`mt-1 w-full border border-rule bg-paper px-3 py-2 text-[13px] text-ink ${FOCUS_RING}`}
              />
              <span className="mt-1 block max-w-prose text-[11.5px] leading-relaxed text-muted">
                One entry is written to the corrections log per record, carrying this
                reason. Already-published records are skipped rather than logged again.
              </span>
            </span>
            <span className={ACTION_ROW}>
              <button
                type="submit"
                disabled={publishing || selected.size === 0 || reason.trim() === ""}
                className={`${ACTION_PRIMARY} ${ACTION_SMALL} ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-40`}
                data-testid="publish-selected"
              >
                {publishing ? "Publishing…" : `Publish ${selected.size} selected`}
              </button>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                disabled={publishing || selected.size === 0}
                className={`${ACTION} ${ACTION_SMALL} ${FOCUS_RING} disabled:opacity-40`}
              >
                Clear
              </button>
            </span>
          </form>
        </>
      )}

      <FlagBar label="Publication" testId="publication-note">
        Publishing is not reversible in the sense that matters: the corrections log
        records that it happened, and unpublishing is a second entry rather than an
        erasure. Records naming a person go to the review queue regardless — this
        screen publishes the meeting record, not the findings drawn from it.
      </FlagBar>
    </>
  );
}

function MeetingRow({
  meeting,
  checked,
  onToggle,
}: {
  meeting: PressroomMeetingSummary;
  checked: boolean;
  onToggle: () => void;
}) {
  const held = meeting.published_at === null;

  return (
    <tr className={`border-b border-rule align-middle last:border-b-0 ${held ? "" : "text-muted"}`}>
      <td className="px-3 py-2.5">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          disabled={!held}
          aria-label={`Select the meeting of ${meeting.date}`}
          data-testid={`select-${meeting.id}`}
        />
      </td>
      <td className="px-3 py-2.5 font-mono tabular text-ink">
        {meeting.date}
        {meeting.time !== null && <span className="ml-2 text-muted">{meeting.time}</span>}
      </td>
      <td className="px-3 py-2.5">
        <span className="block text-ink">{meeting.commission.name}</span>
        {meeting.location !== null && (
          <span className="block text-[11.5px] text-muted">{meeting.location}</span>
        )}
      </td>
      <td className="px-3 py-2.5 tabular">
        {/* Zero documents on an ingested meeting is worth seeing before it is
            published: the record would go public asserting a meeting with
            nothing behind it. */}
        <span className={meeting.document_count === 0 ? "text-accent" : "text-ink"}>
          {meeting.document_count}
        </span>
      </td>
      <td className="px-3 py-2.5">
        {held ? (
          <StatusPill tone="warn">Held</StatusPill>
        ) : (
          <StatusPill tone="ok">Published</StatusPill>
        )}
      </td>
      <td className="px-3 py-2.5">
        <Link
          to={`/admin/meetings/${meeting.id}`}
          className={`text-[12px] underline decoration-rule underline-offset-4 hover:text-ink hover:decoration-accent ${FOCUS_RING}`}
        >
          Open
        </Link>
      </td>
    </tr>
  );
}
