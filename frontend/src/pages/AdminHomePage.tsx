import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useAuth } from "../contexts/useAuth";
import {
  FlagBar,
  FOCUS_RING,
  KeyValues,
  StatusPill,
  Tile,
  Tiles,
  WorkTitle,
} from "@/components/PressroomUI";
import { formatTimestamp } from "@/lib/dates";
import type { PressroomSource, ReviewQueueResponse } from "@/types";

/**
 * `/admin` — the dashboard.
 *
 * This page used to be a list of links to the other pages, because there was
 * no navigation anywhere in the console and something had to stand in for it.
 * The rail is that navigation now, so this stops being a menu and becomes what
 * an operator actually opens the console to find out: **did the presses run,
 * and is anything waiting on me.**
 *
 * Both of its questions are answered from endpoints that already exist, and
 * either may fail without taking the page with it. A dashboard that renders
 * nothing because one count could not be read is a dashboard that gets closed.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

type SourcesState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; sources: PressroomSource[] };

type QueueState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; pending: number; overdue: number };

export function AdminHomePage() {
  const { operator } = useAuth();
  const [sources, setSources] = useState<SourcesState>({ kind: "loading" });
  const [queue, setQueue] = useState<QueueState>({ kind: "loading" });
  const [readAt, setReadAt] = useState<number | null>(null);

  useEffect(() => {
    let ignore = false;
    void (async () => {
      try {
        const res = await fetch("/api/admin/pressroom/sources", { credentials: "same-origin" });
        if (!res.ok) {
          if (!ignore) setSources({ kind: "error" });
          return;
        }
        const body = (await res.json()) as { data: PressroomSource[] };
        if (ignore) return;
        setSources({ kind: "ready", sources: body.data });
        setReadAt(Date.now());
      } catch {
        if (!ignore) setSources({ kind: "error" });
      }
    })();
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    let ignore = false;
    void (async () => {
      try {
        const res = await fetch("/api/admin/review/queue?status=pending_review", {
          credentials: "same-origin",
        });
        if (!res.ok) {
          if (!ignore) setQueue({ kind: "error" });
          return;
        }
        const body = (await res.json()) as ReviewQueueResponse;
        if (ignore) return;
        setQueue({ kind: "ready", pending: body.counts.pending, overdue: body.counts.overdue });
      } catch {
        if (!ignore) setQueue({ kind: "error" });
      }
    })();
    return () => {
      ignore = true;
    };
  }, []);

  const list = sources.kind === "ready" ? sources.sources : [];
  const enabled = list.filter((source) => source.enabled);
  const now = readAt ?? 0;
  const sweptIn24h = enabled.filter(
    (source) =>
      source.last_success_at !== null && now - new Date(source.last_success_at).getTime() < DAY_MS,
  ).length;
  const records = list.reduce((total, source) => total + source.lifetime_records, 0);
  /**
   * Needs attention on **either** axis.
   *
   * A source whose scraper runs cleanly and collects nothing belongs on this
   * list, and before the collection axis existed it could not get onto it —
   * `healthy` was the whole answer. That is the case this panel most needed to
   * surface and was the one case it could not see.
   */
  const failing = list.filter(
    (source) =>
      source.pipeline === "never_run" ||
      source.pipeline === "failing" ||
      source.pipeline === "suspect" ||
      source.collection.verdict === "empty" ||
      source.collection.verdict === "stalled",
  );

  return (
    <>
      <WorkTitle
        title={operator ? operator.name : "Pressroom"}
        stamp={readAt === null ? "reading…" : `read ${new Date(readAt).toLocaleTimeString()}`}
      />

      {/* The one sentence. Everything below it is the evidence for it. */}
      {sources.kind === "loading" ? (
        <p className="label-sm" role="status">
          Reading the sources…
        </p>
      ) : sources.kind === "error" ? (
        <FlagBar label="Unknown" tone="bad" testId="press-verdict">
          The source listing could not be read, so this console cannot say
          whether the presses ran. That is itself a fault — open{" "}
          <Link
            to="/admin/sources"
            className={`font-semibold text-ink underline decoration-rule underline-offset-4 hover:decoration-accent ${FOCUS_RING}`}
          >
            Sources
          </Link>{" "}
          and find out why.
        </FlagBar>
      ) : failing.length > 0 ? (
        <FlagBar label="Did the presses run" tone="bad" testId="press-verdict">
          <b className="font-semibold text-ink">
            {failing.length} of {list.length} source{list.length === 1 ? "" : "s"}
          </b>{" "}
          {failing.length === 1 ? "is" : "are"} not collecting —{" "}
          {failing.map((source) => source.adapter_key).join(", ")}. A stalled
          scraper and a quiet month at City Hall produce identical public sites,
          so this is treated as a failure until proven otherwise.
        </FlagBar>
      ) : list.length === 0 ? (
        <FlagBar label="Did the presses run" tone="bad" testId="press-verdict">
          No ingestion source is registered. Nothing is being watched — that is a
          configuration gap, not a quiet week.
        </FlagBar>
      ) : (
        <FlagBar label="Did the presses run" tone="ok" testId="press-verdict">
          Every registered source is inside its own expected interval. {sweptIn24h}{" "}
          of {enabled.length} enabled source{enabled.length === 1 ? "" : "s"} swept
          in the last 24 hours.
        </FlagBar>
      )}

      <Tiles>
        <Tile
          label="Sources configured"
          value={sources.kind === "ready" ? list.length : "—"}
          sub={sources.kind === "ready" ? `${enabled.length} enabled` : "not read"}
        />
        <Tile
          label="Not collecting"
          value={sources.kind === "ready" ? failing.length : "—"}
          tone={failing.length > 0 ? "bad" : "good"}
          sub="never run, failing or suspect"
        />
        <Tile
          label="Records ingested"
          value={sources.kind === "ready" ? records : "—"}
          tone={sources.kind === "ready" && records === 0 ? "bad" : "plain"}
          sub="lifetime"
          testId="dashboard-lifetime-records"
        />
        <Tile
          label="Waiting on you"
          value={queue.kind === "ready" ? queue.pending : "—"}
          tone={queue.kind === "ready" && queue.overdue > 0 ? "bad" : queue.kind === "ready" && queue.pending > 0 ? "warn" : "good"}
          sub={
            queue.kind === "ready"
              ? `${queue.overdue} overdue`
              : queue.kind === "error"
                ? "queue not read"
                : "reading…"
          }
        />
      </Tiles>

      <div className="grid grid-cols-1 border border-rule lg:grid-cols-[1.35fr_1fr]">
        <div className="flex flex-col gap-3 px-4 py-3.5">
          <span className="label-sm">Sources</span>
          {sources.kind !== "ready" ? (
            <p className="text-sm text-muted">
              {sources.kind === "loading" ? "Reading…" : "The source listing could not be read."}
            </p>
          ) : list.length === 0 ? (
            <p className="text-sm text-accent">No ingestion source is registered.</p>
          ) : (
            <ul className="divide-y divide-rule border-y border-rule">
              {list.map((source) => (
                <li
                  key={source.id}
                  className="flex flex-wrap items-baseline justify-between gap-3 py-2.5 text-[13px]"
                >
                  <span className="font-semibold text-ink">{source.adapter_key}</span>
                  {/* Both axes, because the pill that says "healthy" beside an
                      empty archive is the one that taught us to show two. */}
                  <span className="flex flex-wrap items-baseline gap-1.5">
                    <StatusPill
                      tone={
                        source.pipeline === "healthy"
                          ? "ok"
                          : source.pipeline === "suspect"
                            ? "warn"
                            : source.pipeline === "disabled"
                              ? "idle"
                              : "bad"
                      }
                    >
                      {source.pipeline.replace(/_/g, " ")}
                    </StatusPill>
                    <StatusPill
                      tone={
                        source.collection.verdict === "collecting"
                          ? "ok"
                          : source.collection.verdict === "stalled"
                            ? "warn"
                            : source.collection.verdict === "disabled"
                              ? "idle"
                              : "bad"
                      }
                    >
                      {source.collection.verdict === "empty"
                        ? "no records"
                        : source.collection.verdict === "stalled"
                          ? "no new records"
                          : source.collection.verdict}
                    </StatusPill>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p>
            <Link
              to="/admin/sources"
              className={`text-sm font-semibold text-ink underline decoration-rule underline-offset-4 hover:decoration-accent ${FOCUS_RING}`}
            >
              Every source, its sweeps and its silence watch
            </Link>
          </p>
        </div>

        <div className="flex flex-col gap-3 border-t border-rule bg-paper-sunk px-4 py-3.5 lg:border-l lg:border-t-0">
          <span className="label-sm">This session</span>
          {operator ? (
            <KeyValues
              testId="operator-facts"
              items={[
                { key: "Signed in as", value: operator.email },
                { key: "Role", value: operator.role },
                {
                  key: "Previous sign-in",
                  value: operator.last_login_at
                    ? formatTimestamp(operator.last_login_at)
                    : "First session",
                },
              ]}
            />
          ) : (
            <p className="text-sm text-muted">No operator is on this session.</p>
          )}

          <span className="label-sm mt-1">Review queue</span>
          <p className="max-w-prose text-[12.5px] leading-relaxed text-ink-soft">
            Nothing naming a person publishes itself. A finding at or above the
            review threshold waits here until somebody named approves it with a
            stated reason.
          </p>
          <p>
            <Link
              to="/admin/review"
              className={`text-sm font-semibold text-ink underline decoration-rule underline-offset-4 hover:decoration-accent ${FOCUS_RING}`}
            >
              Open the queue
            </Link>
          </p>
        </div>
      </div>
    </>
  );
}
