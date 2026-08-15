import { useCallback, useEffect, useState } from "react";
import { FlagBar, KeyValues, PressroomCard, Tile, Tiles, WorkTitle } from "@/components/PressroomUI";
import { Absence } from "@/components/ui/Absence";
import type { RosterCoverageState, RosterRoll, RosterRollRow } from "@/types";

/**
 * `/admin/roster` — which body's roster is unsourced, which names went
 * unmatched, and what would have to be fetched to fix it.
 *
 * `rosterCoverage` has computed this since the day it was written and nothing
 * operator-facing read it. `/metrics` reads the aggregate — a distribution over
 * bodies with no body named, because that endpoint is public and id-less and a
 * per-body list there would tell a stranger which counties we hold withheld
 * records for. Here, naming the body is the entire point: the operator is the
 * person who has to go and source it.
 *
 * Four things on this screen are decisions rather than layout.
 *
 * **It renders the zero honestly.** Every body is `unmeasured` and every seat
 * is unsourced today. A screen that dressed that up as a progress bar at 0%
 * would imply a process is running. Nothing is running: nobody has fetched a
 * roster, and the screen says so in those words.
 *
 * **The unmatched names are printed.** Each one is a true claim the verifier
 * will throw away as `not-an-official` — that is the cost of the gap, and a
 * count alone does not tell an operator which page to go and find.
 *
 * **Nothing here writes a member row, and there is no form that could.** The
 * gap is not "these names are missing from a table"; it is "no name in that
 * table can prove where it came from". Typing them in would close the count and
 * make the record worse. The writer is `backend/src/scripts/roster-load.ts`,
 * which requires the fetched bytes, their sha256, the URL and the fetch time
 * for every row, and refuses a name it cannot find in those bytes.
 *
 * **A failed request is not an empty roll.** `null` listing means the console
 * could not ask, and it says that rather than reporting that this project
 * watches no bodies.
 */

const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const STATE_LABEL: Record<RosterCoverageState, string> = {
  accounted: "Every name accounted for",
  partial: "Some names accounted for",
  none: "No name accounted for",
  unmeasured: "Nothing read names an officeholder",
};

/**
 * What each state means for the person reading it, in a sentence.
 *
 * `unmeasured` gets the longest one because it is the state every body is in
 * today and it is the one most easily misread as fine. A roster with nothing to
 * match against matches everything.
 */
const STATE_MEANING: Record<RosterCoverageState, string> = {
  accounted:
    "Every officeholder the stored claims name has a roster row. That is a match against the names, not proof the roster is right.",
  partial: "Some officeholders the record names have no roster row. Each one is a claim the verifier discards.",
  none: "The roster accounts for none of the officeholders the record names.",
  unmeasured:
    "Nothing this project has read for this body names an officeholder, so there is nothing to judge the roster against. This is not coverage — it is an absence of evidence in both directions.",
};

const PROVENANCE_LABEL: Record<RosterRollRow["provenance"], string> = {
  unsourced: "No seat can prove where it came from",
  partial: "Some seats carry a source, some do not",
  sourced: "Every seat carries a source, a fetch time and a hash",
};

/**
 * Worst first.
 *
 * The default order from the API is alphabetical, which is the right order for
 * looking a body up and the wrong one for a screen whose job is to make the
 * next action obvious. Unaccounted names lead, then unsourced seats, then the
 * name — so the body costing the pipeline the most claims is at the top.
 */
function byUrgency(a: RosterRollRow, b: RosterRollRow): number {
  if (b.unmatched.length !== a.unmatched.length) return b.unmatched.length - a.unmatched.length;
  const aUnsourced = a.seats_sourced - a.seats_traceable;
  const bUnsourced = b.seats_sourced - b.seats_traceable;
  if (bUnsourced !== aUnsourced) return bUnsourced - aUnsourced;
  return a.jurisdiction_name.localeCompare(b.jurisdiction_name);
}

const LOADER_COMMAND = `npx tsx src/scripts/roster-load.ts \\
  --jurisdiction <id> \\
  --artifact ./roster-page.html \\
  --source-url https://<the page you fetched> \\
  --fetched-at <ISO 8601> \\
  --roster ./roster.json          # add --commit to write`;

type LoadResult = { ok: true; body: RosterRoll } | { ok: false };

function Body({ row }: { row: RosterRollRow }) {
  return (
    <PressroomCard>
      <div className="flex flex-wrap items-baseline gap-3">
        <h3 className="font-display text-base font-semibold text-ink">{row.jurisdiction_name}</h3>
        <span data-testid={`state-${row.jurisdiction_id}`} className="label-sm">
          {STATE_LABEL[row.state]}
        </span>
      </div>

      <p className="mt-2 max-w-prose text-sm text-ink-soft">{STATE_MEANING[row.state]}</p>

      <div className="mt-4">
        <KeyValues
          testId={`figures-${row.jurisdiction_id}`}
          items={[
            { key: "Seats in term", value: row.seats_sourced },
            {
              key: "Of those, traceable",
              value: row.seats_traceable,
              tone: row.seats_traceable === row.seats_sourced && row.seats_sourced > 0 ? "good" : "bad",
            },
            { key: "Officeholders the record names", value: row.seats_implied },
            {
              key: "Names with no roster row",
              value: row.unmatched.length,
              tone: row.unmatched.length === 0 ? "plain" : "bad",
            },
          ]}
        />
      </div>

      <p data-testid={`provenance-${row.jurisdiction_id}`} className="mt-3 text-sm text-ink-soft">
        {PROVENANCE_LABEL[row.provenance]}.
      </p>

      {row.unmatched.length > 0 && (
        <div className="mt-4">
          <p className="label-sm">Named in the record, absent from the roster</p>
          <ul
            data-testid={`unmatched-${row.jurisdiction_id}`}
            className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-ink"
          >
            {row.unmatched.map((name) => (
              <li key={name} className="font-mono">
                {name}
              </li>
            ))}
          </ul>
          <p className="mt-1 max-w-prose text-xs text-muted">
            As the minutes print them, with the office stripped. Every one of these is a claim the
            extractor verified and the roster check then discarded.
          </p>
        </div>
      )}

      <div className="mt-4">
        <p className="label-sm">Where an operator would start</p>
        {row.website_url === null ? (
          <p
            data-testid={`start-${row.jurisdiction_id}`}
            className="mt-1 max-w-prose text-sm text-ink-soft"
          >
            The record holds no site for this body, so there is no address here to start from.
            Nothing on this screen guesses one.
          </p>
        ) : (
          <p data-testid={`start-${row.jurisdiction_id}`} className="mt-1 text-sm text-ink-soft">
            <a
              href={row.website_url}
              rel="noreferrer noopener"
              className={`break-words underline decoration-rule underline-offset-4 hover:decoration-accent ${focusRing}`}
            >
              {row.website_url}
            </a>{" "}
            — the site recorded for this body. Whether it publishes a roster is not something this
            project has checked.
          </p>
        )}
        <p className="mt-2 text-xs text-muted">
          {row.sources.length === 0 ? (
            "No ingestion adapter is registered against this body."
          ) : (
            <>
              Adapters already registered:{" "}
              {row.sources.map((source, index) => (
                <span key={source.adapter_key} className="font-mono">
                  {index > 0 && ", "}
                  {source.adapter_key}
                  {source.enabled ? "" : " (disabled)"}
                </span>
              ))}
            </>
          )}
        </p>
      </div>
    </PressroomCard>
  );
}

export function AdminRosterPage() {
  const [roll, setRoll] = useState<RosterRoll | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchRoll = useCallback(async (): Promise<LoadResult> => {
    try {
      const res = await fetch("/api/admin/roster", { credentials: "same-origin" });
      if (!res.ok) return { ok: false };
      return { ok: true, body: (await res.json()) as RosterRoll };
    } catch {
      return { ok: false };
    }
  }, []);

  useEffect(() => {
    let ignore = false;
    void (async () => {
      const result = await fetchRoll();
      if (ignore) return;
      if (result.ok) {
        setRoll(result.body);
        setError("");
      } else {
        setError("The roster roll could not be loaded.");
      }
      setLoading(false);
    })();
    return () => {
      ignore = true;
    };
  }, [fetchRoll]);

  const rows = roll === null ? [] : [...roll.data].sort(byUrgency);

  return (
    <>
      <WorkTitle
        title="Roster"
        stamp={
          roll
            ? `${roll.totals.seats_traceable} of ${roll.totals.seats_sourced} seats traceable · as of ${roll.as_of}`
            : undefined
        }
      />

      <p className="mt-6 max-w-prose text-sm leading-relaxed text-ink-soft">
        A roster row that cannot say where it came from is indistinguishable from a row somebody
        typed. That matters beyond tidiness: the claim extractor rejects any sentence about a person
        the roster does not hold, so an unsourced roster both throws away true claims and offers no
        way to check the ones it keeps. This screen counts the gap per body. It does not fill it, and
        nothing here can — a name typed into this console would be the same unsourced row wearing a
        console's authority.
      </p>

      {error && (
        <p
          role="alert"
          className="mt-6 border-l-2 border-accent bg-paper px-4 py-3 text-sm text-ink-soft"
        >
          {error}
        </p>
      )}

      {loading ? (
        <p className="mt-8 label-sm" role="status">
          Loading the roster roll…
        </p>
      ) : roll === null ? (
        /* Not "no bodies are watched". The request failed, so this screen does
          not know what the record holds. */
        <Absence reason="request-failed" subject="The roster roll" />
      ) : (
        <>
          <div className="mt-6">
            <Tiles>
              <Tile label="Bodies" value={roll.provenance.jurisdictions} testId="tile-bodies" />
              <Tile
                label="Seats traceable"
                value={roll.totals.seats_traceable}
                sub={`of ${roll.totals.seats_sourced} in term`}
                tone={roll.totals.seats_traceable === 0 ? "bad" : "plain"}
                testId="tile-traceable"
              />
              <Tile
                label="Names unaccounted"
                value={roll.totals.unmatched}
                sub="claims the verifier discards"
                tone={roll.totals.unmatched === 0 ? "plain" : "bad"}
                testId="tile-unmatched"
              />
              <Tile
                label="Bodies unmeasured"
                value={roll.provenance.unmeasured}
                sub="nothing read names an officeholder"
                testId="tile-unmeasured"
              />
            </Tiles>
          </div>

          {roll.totals.seats_traceable === 0 && (
            <div className="mt-6">
              <FlagBar label="Nothing is sourced" tone="bad" testId="nothing-sourced">
                No roster row in this database carries a source URL, a fetch time and a hash of the
                bytes it was read from. The columns exist — migration 103 added them and deliberately
                backfilled nothing, because every existing row is genuinely unsourced. This figure
                moves when a roster is loaded from bytes somebody fetched, and not before.
              </FlagBar>
            </div>
          )}

          <section className="mt-8">
            <h2 className="font-display text-lg font-semibold text-ink">What would change this</h2>
            <ol className="mt-3 max-w-prose list-decimal space-y-2 pl-5 text-sm leading-relaxed text-ink-soft">
              <li data-testid="step-1">
                <span className="font-semibold text-ink">Provenance columns on the roster — done.</span>{" "}
                <span className="font-mono">source_url</span>,{" "}
                <span className="font-mono">fetched_at</span> and{" "}
                <span className="font-mono">artifact_sha256</span>, with a database constraint that
                takes all three or none. Half a provenance is worse than none: it reads as sourced in
                every listing and proves nothing.
              </li>
              <li data-testid="step-2">
                <span className="font-semibold text-ink">Fetch a published roster and load it.</span>{" "}
                An operator fetches the page, keeps the bytes, and runs the loader with them. Nothing
                in this product fetches a roster on its own, and nothing infers one from the minutes:
                a roster derived from the documents the extractor reads would let a hallucinated name
                validate itself.
              </li>
              <li data-testid="step-3">
                <span className="font-semibold text-ink">
                  Corroborate against the attendance rolls.
                </span>{" "}
                Parsed deterministically, never by the model, and reconciled against what was loaded
                — as a check on the roster, not as a source for it.
              </li>
            </ol>
            <p className="mt-3 max-w-prose text-sm text-ink-soft">
              The loader refuses anything it cannot stand behind: a name that does not appear in the
              fetched bytes, bytes it cannot read as text, a fetch time in the future, a source that
              is not an address. It writes nothing without <span className="font-mono">--commit</span>.
            </p>
            <pre
              data-testid="loader-command"
              className="mt-3 overflow-x-auto whitespace-pre border border-rule bg-paper-sunk p-3 font-mono text-xs leading-relaxed text-ink"
            >
              {LOADER_COMMAND}
            </pre>
          </section>

          <h2 className="mt-8 font-display text-lg font-semibold text-ink">Bodies</h2>
          <p className="mt-1 max-w-prose text-xs text-muted">
            Ordered by what is costing the pipeline most: unaccounted names first, then unsourced
            seats.
          </p>

          {rows.length === 0 ? (
            <Absence reason="none-exist" subject="jurisdictions" />
          ) : (
            <div className="mt-4 space-y-6">
              {rows.map((row) => (
                <Body key={row.jurisdiction_id} row={row} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
