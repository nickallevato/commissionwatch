import { useCallback, useEffect, useState } from "react";
import {
  ACTION,
  ACTION_PRIMARY,
  ACTION_QUIET,
  ACTION_ROW,
  ACTION_SMALL,
  FOCUS_RING,
  FlagBar,
  PressroomCard,
  WorkTitle,
} from "@/components/PressroomUI";
import { Absence } from "@/components/ui/Absence";
import {
  FEATURE_RISKS,
  FEATURE_SOURCES,
  SNAPSHOT_RUN_OUTCOMES,
  type FeatureListing,
  type FeatureRisk,
  type FeatureRow,
  type FeatureSource,
  type SnapshotRunOutcome,
  type SnapshotRunRow,
} from "@/types";

/**
 * `/admin/features` — what is running, what decided it, and the one place to
 * change it.
 *
 * Three features shipped dark behind a `process.env` read. That was right for
 * shipping them and wrong for operating them: turning one off meant editing a
 * SecureString and re-running an SSM deploy — ten minutes, spent on the thing
 * that is already going wrong — and nothing recorded who turned it on, while
 * every smaller act in this product records an actor and a reason.
 *
 * Six things on this screen are decisions rather than layout.
 *
 * **A feature flag is not a wall.** Nothing reachable from here gates the
 * publication wall, the review gate or the claim wall. Those are invariants, not
 * settings, and `backend/test/feature-registry-audit.test.ts` holds the key set
 * to that by vocabulary. This screen switches *whether a capability runs*, never
 * *whether a check applies*, and it says so in those words at the top — because
 * an operator who believes a control exists behaves as though the invariant is
 * negotiable.
 *
 * **The deciding source is named on every row.** This is the point of the
 * screen. An operator who flips a row and sees nothing change must be told that
 * `FEATURE_EVENT_DRAIN=false` is in the deploy config, rather than left to
 * conclude the console is broken and flip it again.
 *
 * **A kill-switched row's control is disabled, in place, with the variable
 * named.** A control that accepts a click and changes nothing is worse than no
 * control, and a disabled button whose reason is one hover away is a disabled
 * button with no reason.
 *
 * **`sends` is a group of its own and demands the key typed out.** It is
 * `event_drain` alone today: the only key that can cause a message to leave the
 * building, and the only one whose consequence cannot be undone by switching it
 * back. Reading the key and typing it is the pause.
 *
 * **The latency is printed as a number, and every figure in it is served.** It is
 * not instant and it is no longer a restart — F1j made both loops re-read per
 * cycle. Saying "takes effect immediately" invites a second click during the gap;
 * saying "restart" is simply false. The screen states the seconds and what they
 * are made of, from the poll interval and the loops' own constants, because a
 * duration typed into this file would be right on the day it was written and
 * would go stale silently on the screen that exists to say how long to wait.
 *
 * **`loadedAt` is shown, separately from the values.** "The switch says on" and
 * "this process has confirmed the switch says on" are different facts.
 */

const RISK_LABEL: Record<FeatureRisk, string> = {
  sends: "Sends — leaves the building",
  publishes: "Publishes — changes what a stranger can read",
  low: "Low — nothing a stranger sees",
};

const RISK_MEANING: Record<FeatureRisk, string> = {
  sends:
    "Turning one of these on can cause a message to leave this system to a person or a service. Switching it back does not recall what was sent, which is why these ask you to type the key.",
  publishes:
    "Turning one of these on changes what a stranger can read. It is reversible, but the window it was open cannot be closed retroactively.",
  low: "Nothing a stranger can see changes and nothing leaves the building. Turning it off again undoes it.",
};

/**
 * What each step means for the person reading it.
 *
 * `kill-switch` and `legacy-env` get the longest sentences because they are the
 * two that explain a switch that appears not to work — the console's own row says
 * one thing and the deploy config is deciding.
 */
const SOURCE_LABEL: Record<FeatureSource, string> = {
  "kill-switch": "an environment kill switch",
  registry: "an operator decision recorded here",
  "legacy-env": "the pre-registry environment variable",
  default: "the default, which is off",
};

const SOURCE_MEANING: Record<FeatureSource, string> = {
  "kill-switch":
    "The environment is forcing this off and the console cannot override it. That is deliberate: the moment you most need to stop a feature is the one where it is hammering the database, and a switch that needs a healthy database to say stop does not work then. Remove the variable from the deploy config to hand the decision back to this screen.",
  registry:
    "Somebody decided this, here, and the decision is in the audit log with their name and their reason.",
  "legacy-env":
    "No operator has decided this key yet, and the variable named below is what is enabling it. Writing a decision here overrides the variable from now on — including a decision to be off, which is a different fact from having defaulted off.",
  default: "No row, no variable. Nothing has enabled this, which is how every feature starts.",
};

/**
 * The step's name for an unrecognised value.
 *
 * Written as a loop over the constant rather than an index with a cast, for the
 * reason `AdminPlaceLinksPage.statusLabel` gives: the field is `string` on the
 * wire, and a cast would render an unknown value as whatever branch fell through
 * instead of as itself.
 */
function sourceOf(source: string): FeatureSource | null {
  for (const known of FEATURE_SOURCES) if (known === source) return known;
  return null;
}

function riskOf(risk: string): FeatureRisk | null {
  for (const known of FEATURE_RISKS) if (known === risk) return known;
  return null;
}

function formatStamp(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function seconds(ms: number): number {
  return Math.ceil(ms / 1000);
}

/**
 * The slowest cycle any loop runs on, or 0 if no key has a loop.
 *
 * Read off the served map rather than known here. The frontend used to carry its
 * own `SLOWEST_CYCLE_SECONDS = 10`, which was right on the day it was written and
 * would have gone stale the day somebody changed the consumer's interval — on the
 * screen whose whole job is saying what is running and how long to wait. The
 * intervals now come from the loops' own exported constants, through the route.
 */
function slowestCycleMs(cycleIntervalMs: Record<string, number>): number {
  let slowest = 0;
  for (const interval of Object.values(cycleIntervalMs)) {
    if (interval > slowest) slowest = interval;
  }
  return slowest;
}

/**
 * Worst case, in seconds, for a change made here to reach every process.
 *
 * Two parts, and both are real and both are served. Each process polls the switch
 * table on `pollIntervalMs`, and then the loop being switched notices on its next
 * cycle. The MCP server resolves per request and adds nothing, which is why it
 * has no entry in the map rather than an entry of zero.
 *
 * The process that served this page is current the moment the write returns; it
 * is the *other* processes this number is about.
 */
function worstCaseSeconds(listing: FeatureListing): number {
  return seconds(listing.pollIntervalMs) + seconds(slowestCycleMs(listing.cycleIntervalMs));
}

/**
 * "5s for the event drain, 10s for the prerender consumer" — composed, not typed
 * out, so a loop that changes its interval or a fourth loop that gains one shows
 * up here without anybody remembering to edit this sentence.
 *
 * Titles come from the listing's own rows, so a key present in the map and absent
 * from the manifest prints as its key rather than vanishing.
 */
function cyclePhrases(listing: FeatureListing): string[] {
  return Object.entries(listing.cycleIntervalMs)
    .sort(([, a], [, b]) => a - b)
    .map(([key, interval]) => {
      const title = listing.features.find((feature) => feature.key === key)?.title ?? key;
      return `${seconds(interval)}s for ${title.toLowerCase()}`;
    });
}

type LoadResult = { ok: true; body: FeatureListing } | { ok: false };

/**
 * The reason form, attached to the row it belongs to rather than in a dialog.
 *
 * `Confirm` stays disabled until a reason is typed, so the requirement is
 * visible before the click rather than arriving as a 400 afterwards — the same
 * choice `AdminSourcesPage`'s toggle row makes, and for the same reason: a form
 * that lets somebody press a button and receive an error it could have prevented
 * trains them to ignore errors.
 *
 * A `sends` feature asks for the key as well. Not a checkbox: the point is to
 * make the operator read which key they are about to make live, and a checkbox
 * can be clicked without reading anything.
 */
function DecisionForm({
  feature,
  busy,
  onCancel,
  onConfirm,
}: {
  feature: FeatureRow;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [typedKey, setTypedKey] = useState("");
  const turningOn = !feature.enabled;
  const needsTypedKey = feature.risk === "sends";
  const keyMatches = !needsTypedKey || typedKey.trim() === feature.key;
  const ready = reason.trim() !== "" && keyMatches && !busy;
  const reasonId = `feature-reason-${feature.key}`;
  const keyId = `feature-confirm-${feature.key}`;

  return (
    <form
      data-testid={`decision-form-${feature.key}`}
      className="mt-4 border-t border-rule pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onConfirm(reason);
      }}
    >
      <label htmlFor={reasonId} className="label-sm block">
        {turningOn ? `Why is ${feature.key} being turned on?` : `Why is ${feature.key} being turned off?`}
      </label>
      <input
        id={reasonId}
        type="text"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder={
          turningOn
            ? "Evaluated on staging; authorised to run in production."
            : "Behaving badly since the 21:40 deploy; off while we read the logs."
        }
        className={`mt-1 w-full border border-rule bg-paper px-3 py-2 text-[13px] text-ink ${FOCUS_RING}`}
      />
      <p className="mt-1 max-w-prose text-[11.5px] leading-relaxed text-muted">
        Required. It goes into the audit log beside your name, and the log is the only record of why
        this is the way it is.
      </p>

      {needsTypedKey && turningOn && (
        <div className="mt-3">
          <label htmlFor={keyId} className="label-sm block">
            Type <span className="font-mono">{feature.key}</span> to confirm
          </label>
          <input
            id={keyId}
            type="text"
            value={typedKey}
            onChange={(event) => setTypedKey(event.target.value)}
            autoComplete="off"
            className={`mt-1 w-full max-w-xs border border-rule bg-paper px-3 py-2 font-mono text-[13px] text-ink ${FOCUS_RING}`}
          />
          <p className="mt-1 max-w-prose text-[11.5px] leading-relaxed text-muted">
            This key can cause a message to leave the building. Switching it back afterwards does not
            recall anything that was sent.
          </p>
        </div>
      )}

      <div className={`mt-3 ${ACTION_ROW}`}>
        <button
          type="submit"
          disabled={!ready}
          data-testid={`confirm-${feature.key}`}
          className={`${ACTION_PRIMARY} ${ACTION_SMALL} ${FOCUS_RING} disabled:cursor-not-allowed`}
        >
          {busy ? "Saving…" : turningOn ? "Turn on" : "Turn off"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className={`${ACTION_QUIET} ${ACTION_SMALL} ${FOCUS_RING}`}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * The one key whose loop keeps a durable ledger, and so the one row that carries
 * one. See `SNAPSHOT_RUN_DAYS` in `backend/src/routes/admin/features.ts`.
 */
const SNAPSHOT_LEDGER_KEY = "dated_export_archive";

const OUTCOME_LABEL: Record<SnapshotRunOutcome, string> = {
  taken: "Snapshot taken",
  skipped_disabled: "Skipped — the feature was off",
  skipped_same_day: "Skipped — the day already had one",
  skipped_locked: "Skipped — another process held the lock",
  failed: "Failed",
};

const OUTCOME_MEANING: Record<SnapshotRunOutcome, string> = {
  taken: "The archive can answer for this day.",
  skipped_disabled:
    "The loop ran and deliberately did nothing. Publication state is one mutable column, so a day nobody snapshotted cannot be reconstructed later.",
  skipped_same_day:
    "A further cycle on a day that already had a snapshot. A no-op, not a duplicate and not an error.",
  skipped_locked:
    "Another container held the advisory lock, so that one did the day's work and this cycle stood down.",
  failed:
    "The cycle raised. The detail is its error text, and the day has no snapshot unless a later cycle took one.",
};

/** As `sourceOf`: matched against the constant, never cast, so an unknown value survives. */
function outcomeOf(outcome: string): SnapshotRunOutcome | null {
  for (const known of SNAPSHOT_RUN_OUTCOMES) if (known === outcome) return known;
  return null;
}

function cycleCount(cycles: number): string {
  return cycles === 1 ? "1 cycle" : `${cycles} cycles`;
}

/**
 * Whether nothing has ever turned this key on, so far as this response can say.
 *
 * Deliberately narrow: off now, no operator decision on record, and no step
 * above the default deciding it. Anything else — a kill switch holding it off, a
 * legacy variable, a recorded decision — leaves open that it has been on, and
 * the console must not claim otherwise from the last change alone.
 */
function neverEnabled(feature: FeatureRow): boolean {
  return !feature.enabled && feature.lastChange === null && feature.source === "default";
}

/** One collapsed day-and-outcome. `cycles` is the repeat count, not a row count. */
function SnapshotRun({ run }: { run: SnapshotRunRow }) {
  const outcome = outcomeOf(run.outcome);

  return (
    <li
      data-testid={`snapshot-run-${run.day}-${run.outcome}`}
      className="border-l-2 border-rule pl-3"
    >
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <span className="tabular label-sm text-ink">{run.day}</span>
        {outcome === null ? (
          <span className="font-mono text-[12.5px] text-ink">{run.outcome}</span>
        ) : (
          <span
            className={`text-[12.5px] font-semibold ${
              outcome === "taken"
                ? "text-pass"
                : outcome === "failed"
                  ? "text-accent"
                  : "text-ink-soft"
            }`}
          >
            {OUTCOME_LABEL[outcome]}
          </span>
        )}
        {/* The count and the last-seen time, always. "It skipped 47 times
          today" and "it skipped once" are the same row shape on the wire and
          only the number tells them apart. */}
        <span className="text-[12.5px] text-muted">
          {cycleCount(run.cycles)}
          {run.cycles > 1 ? (
            <>
              , first <span className="tabular">{formatStamp(run.firstAt)}</span>, last{" "}
              <span className="tabular">{formatStamp(run.lastAt)}</span>
            </>
          ) : (
            <>
              {" "}
              at <span className="tabular">{formatStamp(run.lastAt)}</span>
            </>
          )}
        </span>
      </div>

      <p className="mt-0.5 max-w-prose text-[12.5px] leading-relaxed text-ink-soft">
        {outcome === null
          ? "This build has no words for that outcome, so nothing here says what the loop did. Read the detail and the server's own list of outcomes."
          : OUTCOME_MEANING[outcome]}
      </p>

      {run.detail !== null && (
        <p className="mt-0.5 max-w-prose text-[11.5px] leading-relaxed text-muted">{run.detail}</p>
      )}
      {run.snapshotId !== null && (
        <p className="mt-0.5 text-[11.5px] text-muted">
          Snapshot <span className="font-mono">{run.snapshotId}</span>
        </p>
      )}
    </li>
  );
}

/**
 * The dated archive's cycles, under the switch they are evidence about.
 *
 * This exists because the two states an operator most needs to tell apart look
 * identical from outside: `/api/data/archive` 404s while the flag is off, so it
 * cannot report on its own scheduler, and "the loop skipped every cycle because
 * the flag was off" and "the loop is not running at all" both present as no
 * archive. The ledger separates them — a running loop writes a `skipped_disabled`
 * row every cycle, so a *populated* ledger of skips is proof of life and an
 * *empty* one is not.
 *
 * Which makes the empty case the one this component is really for, and it is
 * four different facts rather than one:
 *
 * - **The field was not served.** An older backend than the loop. Not an empty
 *   ledger — no answer at all, and a confident emptiness rendered against a
 *   server that never sent the data is the precise failure this screen was built
 *   to refuse.
 * - **The read failed.** Same rule as the page's own `request-failed`: we could
 *   not ask, which is not an answer of none.
 * - **Empty, and nothing has ever turned the key on.** Expected, and still not a
 *   claim that the scheduler is alive.
 * - **Empty, and the key is not in its untouched state.** The thing to explain:
 *   every cycle writes a row, so no rows means no cycle has completed here.
 */
function SnapshotLedger({
  feature,
  runs,
  stale,
}: {
  feature: FeatureRow;
  /** `undefined` when the server did not send the field. Never coerced to `[]`. */
  runs: SnapshotRunRow[] | undefined;
  /** The last read of this page failed, so what is in hand may be out of date. */
  stale: boolean;
}) {
  return (
    <div data-testid="snapshot-ledger" className="mt-4 border-t border-rule pt-4">
      {/* "Most recent" and not "the last 30 days": the route asks for 30 *rows*,
        and a day can produce a row per outcome, so the window this covers is
        between six days and thirty and the screen cannot say which. Printing the
        stronger claim would be the same defect as an empty list standing in for
        a failed read. */}
      <h4 className="label-sm text-ink">Snapshot cycles — most recent first</h4>
      <p className="mt-1 max-w-prose text-[12.5px] leading-relaxed text-ink-soft">
        Every cycle of the loop behind this switch is written down, skips and failures included,
        because <span className="font-mono">/api/data/archive</span> answers 404 while the switch is
        off and so cannot report on its own scheduler. A ledger full of skips means the loop is
        running and the flag is off; an empty one does not mean that.
      </p>

      {runs === undefined ? (
        /* No answer, not an answer of none. */
        <p
          data-testid="snapshot-ledger-not-served"
          className="mt-3 max-w-prose text-[12.5px] leading-relaxed text-ink-soft"
        >
          This server did not send the ledger at all — the field is absent from the response, which
          is what a backend older than the snapshot loop looks like. Nothing here can say whether a
          cycle has run or a snapshot has been taken. Read it as no answer, and not as no snapshots.
        </p>
      ) : stale && runs.length === 0 ? (
        <p
          data-testid="snapshot-ledger-request-failed"
          className="mt-3 max-w-prose text-[12.5px] leading-relaxed text-ink-soft"
        >
          The last read of this page failed, so there are no rows in hand and no claim to make about
          them. That is a failure on our side, not a statement that no cycle has run.
        </p>
      ) : runs.length === 0 ? (
        neverEnabled(feature) ? (
          <p
            data-testid="snapshot-ledger-never-enabled"
            className="mt-3 max-w-prose text-[12.5px] leading-relaxed text-ink-soft"
          >
            No cycle has been recorded, and nothing has ever turned{" "}
            <span className="font-mono">{feature.key}</span> on here: it is off, no operator decision
            exists for it, and nothing above the default is deciding it. That is an absence with a
            reason. It is still not evidence that the scheduler is alive — a running loop writes a{" "}
            “{OUTCOME_LABEL.skipped_disabled}” row every cycle even while the switch is off, so if a
            cycle had completed in this deployment there would be one here.
          </p>
        ) : (
          <p
            data-testid="snapshot-ledger-nothing-recorded"
            className="mt-3 max-w-prose text-[12.5px] leading-relaxed text-ink-soft"
          >
            No cycle has been recorded, and this switch is not in its untouched state — so the empty
            ledger is the thing to explain rather than the thing to expect. Every cycle writes a row,
            skips and failures included, so this says the loop has not completed a cycle in this
            deployment: it is not running, or the process has not reached its first tick. It does not
            say a snapshot was taken and lost.
          </p>
        )
      ) : (
        <>
          {stale && (
            <p
              data-testid="snapshot-ledger-stale"
              className="mt-3 max-w-prose text-[12.5px] leading-relaxed text-ink-soft"
            >
              The last read of this page failed, so these rows are from an earlier load and may be
              out of date.
            </p>
          )}
          <ul className="mt-3 space-y-3">
            {runs.map((run) => (
              <SnapshotRun key={`${run.day}-${run.outcome}`} run={run} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** One switch, everything that decided it, and the control — or the reason there is none. */
function Feature({
  feature,
  ledger,
  open,
  busy,
  onOpen,
  onCancel,
  onConfirm,
}: {
  feature: FeatureRow;
  /** The snapshot ledger, on the one row it is evidence about. Null elsewhere. */
  ledger: { runs: SnapshotRunRow[] | undefined; stale: boolean } | null;
  open: boolean;
  busy: boolean;
  onOpen: () => void;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const source = sourceOf(feature.source);
  const change = feature.lastChange;

  return (
    <PressroomCard>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-display text-base font-semibold text-ink">{feature.title}</h3>
        <span className="font-mono text-[11.5px] text-muted">{feature.key}</span>
        <span
          data-testid={`state-${feature.key}`}
          className={`label-sm ${feature.enabled ? "text-pass" : "text-muted"}`}
        >
          {feature.enabled ? "On" : "Off"}
        </span>
      </div>

      <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">{feature.description}</p>

      {/* The deciding step, in words, on every row — not only the interesting
        ones. A note that appears only in the bad case teaches an operator to
        read its absence as nothing having been checked. */}
      <p data-testid={`source-${feature.key}`} className="mt-3 max-w-prose text-sm text-ink">
        <span className="label-sm">Decided by</span>{" "}
        {source === null ? (
          <>
            <span className="font-mono">{feature.source}</span> — this build has no plain-words
            meaning for that step, so nothing here says what is deciding. Do not act on the value
            alone.
          </>
        ) : (
          <>
            {SOURCE_LABEL[source]}.{" "}
            <span className="text-ink-soft">{SOURCE_MEANING[source]}</span>
          </>
        )}
      </p>

      {feature.legacyEnv !== null && (
        <p className="mt-2 text-xs text-muted">
          Pre-registry variable: <span className="font-mono">{feature.legacyEnv}</span>. It still
          works and the deploy config still documents it. A decision written here outranks it.
        </p>
      )}

      {feature.requiresSeed !== null && (
        <div className="mt-3">
          <FlagBar label="Needs a step besides this switch" tone="warn" testId={`requires-${feature.key}`}>
            {feature.requiresSeed}
          </FlagBar>
        </div>
      )}

      <p data-testid={`last-change-${feature.key}`} className="mt-3 max-w-prose text-sm text-ink-soft">
        <span className="label-sm">Last change</span>{" "}
        {change === null ? (
          <>
            None. No operator has decided this key, so nothing here has an author — which is a
            different fact from a decision to leave it off.
          </>
        ) : (
          <>
            {change.enabledFrom === null ? "First decision" : change.enabledFrom ? "On" : "Off"} →{" "}
            {change.enabledTo ? "on" : "off"} by{" "}
            <span className="font-mono">{change.operatorEmail ?? "an account since deleted"}</span> on{" "}
            <span className="tabular">{formatStamp(change.at)}</span>. “{change.reason}”
          </>
        )}
      </p>

      {/* Under the switch it is evidence about, not in a section of its own.
        "Has this loop been running" is a question about this row. */}
      {ledger !== null && (
        <SnapshotLedger feature={feature} runs={ledger.runs} stale={ledger.stale} />
      )}

      {feature.forcedOff ? (
        /* In place, with the variable named. See the file header. */
        <div className="mt-4">
          <FlagBar label="Held off by the environment" tone="bad" testId={`forced-off-${feature.key}`}>
            <span className="font-mono">{feature.killSwitchEnv}</span> is set in the deploy config, so
            this feature is off no matter what is recorded here and this console cannot turn it on.
            The lever is deliberately one-directional — the environment can force a feature off and
            can never force one on, because an enable that carries no operator and no reason is the
            thing this screen exists to remove.
          </FlagBar>
          <button
            type="button"
            disabled
            data-testid={`toggle-${feature.key}`}
            className={`mt-3 ${ACTION} ${ACTION_SMALL} disabled:cursor-not-allowed`}
          >
            {feature.enabled ? "Turn off" : "Turn on"}
          </button>
        </div>
      ) : open ? (
        <DecisionForm feature={feature} busy={busy} onCancel={onCancel} onConfirm={onConfirm} />
      ) : (
        <div className={`mt-4 ${ACTION_ROW}`}>
          <button
            type="button"
            onClick={onOpen}
            data-testid={`toggle-${feature.key}`}
            className={`${feature.enabled ? ACTION : ACTION_PRIMARY} ${ACTION_SMALL} ${FOCUS_RING}`}
          >
            {feature.enabled ? "Turn off" : "Turn on"}
          </button>
        </div>
      )}
    </PressroomCard>
  );
}

export function AdminFeaturesPage() {
  const [listing, setListing] = useState<FeatureListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [openKey, setOpenKey] = useState("");
  const [busy, setBusy] = useState("");

  const fetchFeatures = useCallback(async (): Promise<LoadResult> => {
    try {
      const res = await fetch("/api/admin/features", { credentials: "same-origin" });
      if (!res.ok) return { ok: false };
      return { ok: true, body: (await res.json()) as FeatureListing };
    } catch {
      return { ok: false };
    }
  }, []);

  const applyResult = useCallback((result: LoadResult) => {
    if (result.ok) {
      setListing(result.body);
      setError("");
    } else {
      // Not an empty list. Two operator screens shipped in one day reporting
      // "the record shows none" when the request had failed, which is the
      // strongest available claim on the weakest available evidence.
      setError("The feature switches could not be loaded.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    let ignore = false;
    void (async () => {
      const result = await fetchFeatures();
      if (ignore) return;
      applyResult(result);
    })();
    return () => {
      ignore = true;
    };
  }, [applyResult, fetchFeatures]);

  async function write(feature: FeatureRow, reason: string) {
    setBusy(feature.key);
    setNotice("");
    try {
      const res = await fetch(`/api/admin/features/${feature.key}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !feature.enabled, reason }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        // Verbatim. The API's refusals — unknown key, empty reason, no-op — say
        // exactly what is wrong, and a paraphrase here would be a second thing
        // to debug.
        setNotice(payload?.error ?? "The switch could not be changed.");
      } else {
        setNotice(
          feature.enabled
            ? `${feature.key} is off. Every process stops within the window stated above.`
            : `${feature.key} is on. Every process starts within the window stated above.`,
        );
        setOpenKey("");
        applyResult(await fetchFeatures());
      }
    } catch {
      setNotice("The change could not be sent.");
    }
    setBusy("");
  }

  const features = listing?.features ?? [];
  const loadedAt = features[0]?.loadedAt ?? null;
  const unknownRisk = features.filter((feature) => riskOf(feature.risk) === null);

  /**
   * The ledger belongs to one row and travels with the listing that carried it.
   *
   * `listing.snapshotRuns` is passed through **as it arrived** — `undefined` when
   * the server sent no such field — because the component's whole job is telling
   * that apart from an empty array, and defaulting it here would erase the
   * distinction before it ever reached the screen.
   */
  function ledgerFor(feature: FeatureRow) {
    if (listing === null || feature.key !== SNAPSHOT_LEDGER_KEY) return null;
    return { runs: listing.snapshotRuns, stale: error !== "" };
  }

  return (
    <>
      <WorkTitle
        title="Features"
        stamp={
          listing
            ? `${features.filter((feature) => feature.enabled).length} of ${features.length} on · read ${formatStamp(loadedAt)}`
            : undefined
        }
      />

      <p className="mt-6 max-w-prose text-sm leading-relaxed text-ink-soft">
        Every switch here decides <span className="font-semibold text-ink">whether a capability
        runs</span>, and none of them decides whether a check applies. The publication wall, the
        review gate and the claim wall are not features and have no rows: there is deliberately
        nothing on this screen that can turn one off, and a test in the backend holds the switch list
        to that. Turning something on changes what this system does; it never changes what it
        refuses.
      </p>

      {/* Every figure in this sentence is served. See `worstCaseSeconds`. */}
      {listing && (
        <p data-testid="latency" className="mt-3 max-w-prose text-sm leading-relaxed text-ink-soft">
          A change here reaches every process within about{" "}
          <span className="tabular font-semibold text-ink">{worstCaseSeconds(listing)} seconds</span>
          : up to {seconds(listing.pollIntervalMs)}s for each process to poll the switch
          {cyclePhrases(listing).length > 0 && (
            <>, then up to one cycle of the loop it gates — {cyclePhrases(listing).join(", ")}</>
          )}
          . A feature with no loop of its own — the MCP server, which resolves its switch on every
          request — adds nothing to that. It is not instant, and it no longer needs a restart.
        </p>
      )}

      {/* Only with a row in hand: `loadedAt` is read off one, so with an empty
        list "this process has never read the table" would be a claim about the
        process made from the absence of features rather than from the field. */}
      {features.length > 0 && (
        <p data-testid="loaded-at" className="mt-3 max-w-prose text-xs text-muted">
          The values below are what the process serving this page has read from the switch table
          {loadedAt === null ? (
            <>
              , and it has <span className="font-semibold text-ink">never read it</span> — so every
              row is resolving through the environment and the default alone.
            </>
          ) : (
            <>
              , as of <span className="tabular">{formatStamp(loadedAt)}</span>. “The switch says on”
              and “this process has confirmed the switch says on” are different facts.
            </>
          )}
        </p>
      )}

      {error && (
        <p
          role="alert"
          className="mt-6 border-l-2 border-accent bg-paper px-4 py-3 text-sm text-ink-soft"
        >
          {error}
        </p>
      )}

      {notice && (
        <p
          role="status"
          className="mt-6 border-l-2 border-ink bg-paper px-4 py-3 text-sm text-ink-soft"
        >
          {notice}
        </p>
      )}

      {loading ? (
        <p className="mt-8 label-sm" role="status">
          Loading the feature switches…
        </p>
      ) : listing === null ? (
        /* Not "there are no features". The request failed, so this screen does
          not know what is running — which on this screen of all screens is the
          one thing it must not guess. */
        <Absence reason="request-failed" subject="The feature switches" />
      ) : features.length === 0 ? (
        <Absence reason="none-exist" subject="feature switches" />
      ) : (
        <>
          {FEATURE_RISKS.map((risk) => {
            const group = features.filter((feature) => riskOf(feature.risk) === risk);
            if (group.length === 0) return null;

            return (
              <section key={risk} className="mt-8" data-testid={`group-${risk}`}>
                <h2
                  className={`font-display text-lg font-semibold ${risk === "sends" ? "text-accent" : "text-ink"}`}
                >
                  {RISK_LABEL[risk]}
                </h2>
                <p className="mt-1 max-w-prose text-sm text-ink-soft">{RISK_MEANING[risk]}</p>
                <div className={`mt-4 space-y-6 ${risk === "sends" ? "border-l-2 border-accent pl-4" : ""}`}>
                  {group.map((feature) => (
                    <Feature
                      key={feature.key}
                      feature={feature}
                      ledger={ledgerFor(feature)}
                      open={openKey === feature.key}
                      busy={busy === feature.key}
                      onOpen={() => {
                        setNotice("");
                        setOpenKey(feature.key);
                      }}
                      onCancel={() => setOpenKey("")}
                      onConfirm={(reason) => void write(feature, reason)}
                    />
                  ))}
                </div>
              </section>
            );
          })}

          {/* A risk grade this build does not recognise still gets a section. A
            switch missing from this screen is a switch nobody knows exists. */}
          {unknownRisk.length > 0 && (
            <section className="mt-8" data-testid="group-unknown">
              <h2 className="font-display text-lg font-semibold text-ink">Risk not recognised</h2>
              <p className="mt-1 max-w-prose text-sm text-ink-soft">
                The server graded these with a value this build has no words for, so nothing here
                says what turning one on would cost. Read the description before deciding.
              </p>
              <div className="mt-4 space-y-6">
                {unknownRisk.map((feature) => (
                  <Feature
                    key={feature.key}
                    feature={feature}
                    ledger={ledgerFor(feature)}
                    open={openKey === feature.key}
                    busy={busy === feature.key}
                    onOpen={() => {
                      setNotice("");
                      setOpenKey(feature.key);
                    }}
                    onCancel={() => setOpenKey("")}
                    onConfirm={(reason) => void write(feature, reason)}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
}
