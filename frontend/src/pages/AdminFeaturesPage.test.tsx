import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AdminFeaturesPage } from "./AdminFeaturesPage";
import { server } from "@/mocks/server";
import type {
  FeatureListing,
  FeatureRow,
  FeatureWriteResult,
  SnapshotRunRow,
} from "@/types";

/**
 * `/admin/features` — the switch panel.
 *
 * What this suite guards is not layout. It is the seven things that make this
 * screen safe to act on:
 *
 * **No switch on it gates a wall, and it says so.** The publication wall, the
 * review gate and the claim wall are invariants. A console that implied one of
 * them was a setting would be worse than no console, because a setting is
 * something somebody eventually changes at 11pm.
 *
 * **The deciding source is named on every row.** An operator who flips a row and
 * sees nothing change must be told `FEATURE_EVENT_DRAIN=false` is in the deploy
 * config, not left to conclude the console is broken and flip it again.
 *
 * **A kill-switched row's control is disabled, with the variable named in
 * place.** A control that accepts a click and changes nothing is worse than no
 * control.
 *
 * **`sends` is grouped apart and demands the key typed out.** It is the one grade
 * whose consequence switching back does not undo.
 *
 * **A reason is required before the click, not after a 400.**
 *
 * **The latency is a number, and it is neither "instant" nor "restart".** Both of
 * those are false, and each is false in a way that produces a wrong action.
 *
 * **A failed request is not an empty list.** On the screen whose whole purpose is
 * to say what is running, "there are no features" is the one answer that must
 * never be guessed.
 *
 * Every operator name here is invented.
 */

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const LOADED_AT = "2026-08-15T21:40:00.000Z";

const DRAIN: FeatureRow = {
  key: "event_drain",
  title: "Event drain",
  description: "The drain claims undispatched rows from events and hands them to the dispatcher.",
  risk: "sends",
  legacyEnv: "EVENT_DRAIN_ENABLED",
  requiresSeed: null,
  killSwitchEnv: "FEATURE_EVENT_DRAIN",
  enabled: false,
  source: "default",
  loadedAt: LOADED_AT,
  forcedOff: false,
  lastChange: null,
};

const PRERENDER: FeatureRow = {
  key: "prerender",
  title: "Prerendered pages",
  description: "The consumer writes a static document per published record for crawlers.",
  risk: "publishes",
  legacyEnv: "PRERENDER_ENABLED",
  requiresSeed:
    "Run `npm run prerender:rebuild` after enabling. The consumer only walks events past its cursor.",
  killSwitchEnv: "FEATURE_PRERENDER",
  enabled: true,
  source: "registry",
  loadedAt: LOADED_AT,
  forcedOff: false,
  lastChange: {
    enabledFrom: null,
    enabledTo: true,
    operatorId: "11111111-2222-4333-8444-000000000001",
    operatorEmail: "invented.operator@example.invalid",
    reason: "Serving static copies for readers without JavaScript.",
    at: "2026-08-15T20:00:00.000Z",
  },
};

const NARRATIVE: FeatureRow = {
  key: "generated_narrative",
  title: "Generated finding narrative",
  description: "The composer drafts prose for a finding into the operator review queue.",
  risk: "low",
  legacyEnv: null,
  requiresSeed: null,
  killSwitchEnv: "FEATURE_GENERATED_NARRATIVE",
  enabled: false,
  source: "default",
  loadedAt: LOADED_AT,
  forcedOff: false,
  lastChange: null,
};

/**
 * The archive switch, in its untouched state: off, defaulted, never decided.
 *
 * The row the snapshot ledger hangs off. It is the only key in the manifest
 * whose loop leaves a durable record, which is why it is the only row that
 * carries one.
 */
const ARCHIVE: FeatureRow = {
  key: "dated_export_archive",
  title: "Dated export archive",
  description: "`/api/data/archive` serves point-in-time exports addressed by date.",
  risk: "publishes",
  legacyEnv: null,
  requiresSeed: null,
  killSwitchEnv: "FEATURE_DATED_EXPORT_ARCHIVE",
  enabled: false,
  source: "default",
  loadedAt: LOADED_AT,
  forcedOff: false,
  lastChange: null,
};

const SKIPPED: SnapshotRunRow = {
  day: "2026-08-15",
  outcome: "skipped_disabled",
  cycles: 47,
  firstAt: "2026-08-15T00:14:00.000Z",
  lastAt: "2026-08-15T22:14:00.000Z",
  snapshotId: null,
  detail:
    "the dated_export_archive feature is off, so no snapshot was taken and the archive cannot answer for this day",
};

const TAKEN: SnapshotRunRow = {
  day: "2026-08-14",
  outcome: "taken",
  cycles: 1,
  firstAt: "2026-08-14T01:14:00.000Z",
  lastAt: "2026-08-14T01:14:00.000Z",
  snapshotId: "33333333-4444-4555-8666-000000000009",
  detail: "6 dataset(s), 1204 row(s)",
};

function listing(features: FeatureRow[] = [DRAIN, PRERENDER, NARRATIVE]): FeatureListing {
  return {
    features,
    pollIntervalMs: 5000,
    // Keyed by feature key, from the loops' own exported constants on the server.
    // `mcp_server` is absent because it has no loop, which is not zero.
    cycleIntervalMs: { event_drain: 5000, prerender: 10000 },
  };
}

function serve(body: FeatureListing): void {
  server.use(http.get("/api/admin/features", () => HttpResponse.json(body)));
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminFeaturesPage />
    </MemoryRouter>,
  );
}

describe("AdminFeaturesPage", () => {
  it("says in words that no switch here gates a check", async () => {
    serve(listing());
    renderPage();

    await screen.findByText("Event drain");
    // The sentence is the artifact. An operator who believes the walls are
    // switchable behaves as though they are negotiable.
    expect(screen.getByText(/whether a capability/i)).toBeInTheDocument();
    expect(
      screen.getByText(/never changes what it refuses/i, { exact: false }),
    ).toBeInTheDocument();
  });

  it("groups by risk, with sends in its own section", async () => {
    serve(listing());
    renderPage();

    const sends = await screen.findByTestId("group-sends");
    expect(within(sends).getByText("Event drain")).toBeInTheDocument();
    // The one key that can cause a message to leave the building is not filed
    // next to a key that writes a file.
    expect(within(sends).queryByText("Prerendered pages")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("group-publishes")).getByText("Prerendered pages")).toBeInTheDocument();
    expect(within(screen.getByTestId("group-low")).getByText("Generated finding narrative")).toBeInTheDocument();
  });

  it("names the deciding source on every row", async () => {
    serve(listing());
    renderPage();

    await screen.findByText("Event drain");
    expect(screen.getByTestId("source-event_drain")).toHaveTextContent(/default, which is off/i);
    expect(screen.getByTestId("source-prerender")).toHaveTextContent(/operator decision recorded here/i);
  });

  it("explains a legacy variable rather than reporting the value alone", async () => {
    // The row that looks broken: on, and no operator decided it. Without the
    // sentence naming the variable, the console reads as having lied.
    serve(listing([{ ...DRAIN, enabled: true, source: "legacy-env" }]));
    renderPage();

    const source = await screen.findByTestId("source-event_drain");
    expect(source).toHaveTextContent(/pre-registry environment variable/i);
    expect(screen.getByText("EVENT_DRAIN_ENABLED")).toBeInTheDocument();
  });

  it("disables the control on a kill-switched row and names the variable in place", async () => {
    serve(listing([{ ...DRAIN, forcedOff: true, source: "kill-switch" }]));
    renderPage();

    const toggle = await screen.findByTestId("toggle-event_drain");
    expect(toggle).toBeDisabled();

    // In place, not in a tooltip: a disabled button whose reason is one hover
    // away is a disabled button with no reason.
    const flag = screen.getByTestId("forced-off-event_drain");
    expect(flag).toHaveTextContent("FEATURE_EVENT_DRAIN");
    expect(flag).toHaveTextContent(/cannot turn it on/i);
    expect(flag).toHaveTextContent(/one-directional/i);
  });

  it("requires a reason before the write can be sent", async () => {
    serve(listing());
    renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("toggle-generated_narrative"));
    const confirm = screen.getByTestId("confirm-generated_narrative");
    // Visibly required before the click, rather than a 400 afterwards.
    expect(confirm).toBeDisabled();

    await user.type(
      screen.getByLabelText(/why is generated_narrative being turned on/i),
      "Drafting into the review queue to evaluate it.",
    );
    expect(confirm).toBeEnabled();
  });

  it("demands the key typed out before a sends feature goes on", async () => {
    serve(listing());
    renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("toggle-event_drain"));
    await user.type(
      screen.getByLabelText(/why is event_drain being turned on/i),
      "Authorised after the staging run.",
    );

    // A reason alone is not enough for the one key that can send.
    const confirm = screen.getByTestId("confirm-event_drain");
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText(/type event_drain to confirm/i), "event_drain");
    expect(confirm).toBeEnabled();
  });

  it("sends the inverted value with the typed reason", async () => {
    const sent = vi.fn();
    serve(listing());
    server.use(
      http.put("/api/admin/features/prerender", async ({ request }) => {
        sent(await request.json());
        // Typed, so this mock cannot drift from what `PUT /api/admin/features/:key`
        // actually answers with.
        const written: FeatureWriteResult = {
          key: "prerender",
          enabled: false,
          source: "registry",
          loadedAt: LOADED_AT,
          forcedOff: false,
          lastChange: null,
        };
        return HttpResponse.json(written);
      }),
    );
    renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("toggle-prerender"));
    await user.type(
      screen.getByLabelText(/why is prerender being turned off/i),
      "Writing pages nobody serves yet.",
    );
    await user.click(screen.getByTestId("confirm-prerender"));

    // Inverted from the row's current value, never read off a checkbox that
    // could have drifted from what the screen is showing.
    await waitFor(() =>
      expect(sent).toHaveBeenCalledWith({
        enabled: false,
        reason: "Writing pages nobody serves yet.",
      }),
    );
  });

  it("shows the API's own refusal verbatim", async () => {
    serve(listing());
    server.use(
      http.put("/api/admin/features/generated_narrative", () =>
        HttpResponse.json({ error: "generated_narrative is already disabled", statusCode: 409 }, { status: 409 }),
      ),
    );
    renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("toggle-generated_narrative"));
    await user.type(screen.getByLabelText(/why is generated_narrative/i), "Trying it.");
    await user.click(screen.getByTestId("confirm-generated_narrative"));

    // A paraphrase would be a second thing to debug.
    expect(await screen.findByText("generated_narrative is already disabled")).toBeInTheDocument();
  });

  it("prints the latency as a number, and neither as instant nor as a restart", async () => {
    serve(listing());
    renderPage();

    const latency = await screen.findByTestId("latency");
    // 5s poll + the slowest served cycle, which is the consumer's 10s.
    expect(latency).toHaveTextContent("15 seconds");
    expect(latency).toHaveTextContent("5s for event drain");
    expect(latency).toHaveTextContent("10s for prerendered pages");
    expect(latency).toHaveTextContent(/not instant/i);
    expect(latency).toHaveTextContent(/no longer needs a restart/i);
    expect(latency.textContent ?? "").not.toMatch(/takes effect on restart/i);
  });

  it("recomputes the latency from the served poll interval", async () => {
    serve({ ...listing(), pollIntervalMs: 30000 });
    renderPage();

    expect(await screen.findByTestId("latency")).toHaveTextContent("40 seconds");
  });

  it("recomputes the latency from the served cycle intervals", async () => {
    // The half that used to be a constant in this file. If the drain's or the
    // consumer's interval changes on the server, the number here moves with it —
    // which is what makes the single-sourcing load-bearing rather than cosmetic.
    serve({ ...listing(), cycleIntervalMs: { event_drain: 5000, prerender: 60000 } });
    renderPage();

    const latency = await screen.findByTestId("latency");
    expect(latency).toHaveTextContent("65 seconds");
    expect(latency).toHaveTextContent("60s for prerendered pages");
  });

  it("names a loop the server reports that this build has no manifest row for", async () => {
    // A key in the cycle map and not in the features list still contributes its
    // wait. Printing its key beats dropping it from a sentence about how long to
    // wait for it.
    serve({
      ...listing(),
      cycleIntervalMs: { event_drain: 5000, prerender: 10000, scheduled_extraction: 45000 },
    });
    renderPage();

    const latency = await screen.findByTestId("latency");
    expect(latency).toHaveTextContent("50 seconds");
    expect(latency).toHaveTextContent("45s for scheduled_extraction");
  });

  it("adds no wait for a deployment whose features have no loops", async () => {
    // Not "instant": the poll still has to happen. Absence in the map is absence
    // of a loop, never a zero that rounds the sentence down to nothing.
    serve({ ...listing(), cycleIntervalMs: {} });
    renderPage();

    const latency = await screen.findByTestId("latency");
    expect(latency).toHaveTextContent("5 seconds");
    expect(latency.textContent ?? "").not.toMatch(/one cycle of the loop/i);
  });

  it("shows when this process last read the switch table", async () => {
    serve(listing());
    renderPage();

    const loaded = await screen.findByTestId("loaded-at");
    expect(loaded).toHaveTextContent(/confirmed the switch says on/i);
  });

  it("says so when the serving process has never read the table", async () => {
    // Every row is then resolving through the environment and the default, which
    // is a different claim from "these are the switches".
    serve(listing([{ ...DRAIN, loadedAt: null }]));
    renderPage();

    expect(await screen.findByTestId("loaded-at")).toHaveTextContent(/never read it/i);
  });

  it("surfaces the rebuild step on the row that needs it", async () => {
    serve(listing());
    renderPage();

    // On the row, not in a document. A prerequisite that lives only in
    // docs/STATUS.md is one that gets skipped.
    const flag = await screen.findByTestId("requires-prerender");
    expect(flag).toHaveTextContent("npm run prerender:rebuild");
  });

  it("reports the last change with its actor and reason", async () => {
    serve(listing());
    renderPage();

    const change = await screen.findByTestId("last-change-prerender");
    expect(change).toHaveTextContent("invented.operator@example.invalid");
    expect(change).toHaveTextContent("Serving static copies for readers without JavaScript.");
  });

  it("distinguishes a key nobody has decided from a decision to be off", async () => {
    serve(listing());
    renderPage();

    const change = await screen.findByTestId("last-change-event_drain");
    expect(change).toHaveTextContent(/no operator has decided this key/i);
  });

  it("renders an error rather than an empty list when the request fails", async () => {
    server.use(http.get("/api/admin/features", () => HttpResponse.error()));
    renderPage();

    // "There are no features" is the strongest available claim on the weakest
    // available evidence, on the screen whose whole purpose is saying what runs.
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be loaded/i);
    expect(screen.queryByTestId("group-sends")).not.toBeInTheDocument();
    // `Absence` says it in the shared words: a failure of ours, explicitly not a
    // statement that there are none.
    expect(screen.getByText(/not a statement that there are none/i)).toBeInTheDocument();
  });

  /**
   * The snapshot ledger, under the switch it is evidence about.
   *
   * The reason it exists: `/api/data/archive` 404s while `dated_export_archive`
   * is off, so it cannot report on its own scheduler, and "the loop skipped every
   * cycle because the flag was off" and "the loop is not running at all" are
   * indistinguishable from outside. A populated ledger of skips is proof of life;
   * an empty one is not — which is why the empty case is four different facts
   * here and never one.
   */
  describe("the snapshot ledger", () => {
    function withRuns(runs: SnapshotRunRow[] | undefined, feature: FeatureRow = ARCHIVE): FeatureListing {
      const body = listing([DRAIN, feature]);
      // Assigned rather than spread with `snapshotRuns: undefined`, so the
      // "older backend" case is a genuinely absent key in the JSON body and not
      // a present key holding undefined.
      if (runs !== undefined) body.snapshotRuns = runs;
      return body;
    }

    it("renders the ledger inside the dated export archive row, not in a section of its own", async () => {
      serve(withRuns([SKIPPED, TAKEN]));
      renderPage();

      const ledger = await screen.findByTestId("snapshot-ledger");
      // Evidence about one switch belongs on that switch. An operator looking at
      // the archive row must not have to find a separate panel to learn that its
      // loop has never ticked.
      const card = ledger.closest("section");
      expect(card).not.toBeNull();
      expect(within(card as HTMLElement).getByText("Dated export archive")).toBeInTheDocument();
      expect(within(card as HTMLElement).queryByText("Event drain")).not.toBeInTheDocument();
    });

    it("prints the repeat count, so 47 skips do not read as one", async () => {
      serve(withRuns([SKIPPED, TAKEN]));
      renderPage();

      // The row is a collapsed repeat: `(run_day, outcome)` is unique and a
      // further cycle increments `cycles`. Without the number on screen, a loop
      // that skipped all day and a loop that ticked once look identical.
      const skipped = await screen.findByTestId("snapshot-run-2026-08-15-skipped_disabled");
      expect(skipped).toHaveTextContent("47 cycles");
      expect(skipped).toHaveTextContent(/skipped — the feature was off/i);
      expect(skipped).toHaveTextContent(/cannot answer for this day/i);

      const taken = screen.getByTestId("snapshot-run-2026-08-14-taken");
      expect(taken).toHaveTextContent("1 cycle");
      expect(taken).not.toHaveTextContent("1 cycles");
      expect(taken).toHaveTextContent("33333333-4444-4555-8666-000000000009");
    });

    it("renders an outcome this build does not recognise as itself", async () => {
      // Same rule as the unrecognised risk grade. A cycle dropped from this list
      // is a cycle nobody knows happened.
      serve(withRuns([{ ...SKIPPED, outcome: "skipped_quiesced", cycles: 3 }]));
      renderPage();

      const run = await screen.findByTestId("snapshot-run-2026-08-15-skipped_quiesced");
      expect(run).toHaveTextContent("skipped_quiesced");
      expect(run).toHaveTextContent("3 cycles");
      expect(run).toHaveTextContent(/no words for that outcome/i);
    });

    it("says the server sent no ledger at all rather than rendering an empty one", async () => {
      // A backend older than the loop. This is the failure the whole screen was
      // built to refuse: a confident emptiness rendered against a server that
      // never sent the data. "No answer" and "no snapshots" are different facts
      // and they must not share a rendering.
      serve(withRuns(undefined));
      renderPage();

      const note = await screen.findByTestId("snapshot-ledger-not-served");
      expect(note).toHaveTextContent(/did not send the ledger at all/i);
      expect(note).toHaveTextContent(/no answer, and not as no snapshots/i);
      expect(screen.queryByTestId("snapshot-ledger-never-enabled")).not.toBeInTheDocument();
      expect(screen.queryByTestId("snapshot-ledger-nothing-recorded")).not.toBeInTheDocument();
    });

    it("distinguishes an empty ledger on a switch nothing has ever turned on", async () => {
      serve(withRuns([]));
      renderPage();

      const note = await screen.findByTestId("snapshot-ledger-never-enabled");
      expect(note).toHaveTextContent(/nothing has ever turned/i);
      // And still not a claim that the scheduler is alive: a running loop writes
      // a skip row every cycle even while the switch is off.
      expect(note).toHaveTextContent(/not evidence that the scheduler is alive/i);
      expect(screen.queryByTestId("snapshot-ledger-not-served")).not.toBeInTheDocument();
    });

    it("distinguishes an empty ledger on a switch somebody has decided", async () => {
      // On, decided, and no cycle recorded. That is the state that needs
      // explaining rather than the one to expect, and it is not the same
      // sentence as a switch nobody has touched.
      serve(
        withRuns([], {
          ...ARCHIVE,
          enabled: true,
          source: "registry",
          lastChange: {
            enabledFrom: null,
            enabledTo: true,
            operatorId: "11111111-2222-4333-8444-000000000002",
            operatorEmail: "invented.operator@example.invalid",
            reason: "Recording days before the archive is served.",
            at: "2026-08-15T19:00:00.000Z",
          },
        }),
      );
      renderPage();

      const note = await screen.findByTestId("snapshot-ledger-nothing-recorded");
      expect(note).toHaveTextContent(/not in its untouched state/i);
      expect(note).toHaveTextContent(/has not completed a cycle/i);
      expect(screen.queryByTestId("snapshot-ledger-never-enabled")).not.toBeInTheDocument();
    });

    /** A first load that answers, then a reload that does not. */
    function serveThenFail(body: FeatureListing): void {
      let served = 0;
      server.use(
        http.get("/api/admin/features", () => {
          served += 1;
          return served === 1 ? HttpResponse.json(body) : HttpResponse.error();
        }),
        http.put("/api/admin/features/dated_export_archive", () => {
          const written: FeatureWriteResult = {
            key: "dated_export_archive",
            enabled: true,
            source: "registry",
            loadedAt: LOADED_AT,
            forcedOff: false,
            lastChange: null,
          };
          return HttpResponse.json(written);
        }),
      );
    }

    async function reloadAfterWrite(): Promise<void> {
      const user = userEvent.setup();
      await user.click(await screen.findByTestId("toggle-dated_export_archive"));
      await user.type(
        screen.getByLabelText(/why is dated_export_archive being turned on/i),
        "Recording days before the archive is served.",
      );
      await user.click(screen.getByTestId("confirm-dated_export_archive"));
    }

    it("renders a failed read as a failed read, never as an empty ledger", async () => {
      serveThenFail(withRuns([]));
      renderPage();
      await reloadAfterWrite();

      // We could not ask. That is not an answer of none, and on this row it is
      // not "the loop has recorded nothing" either.
      const note = await screen.findByTestId("snapshot-ledger-request-failed");
      expect(note).toHaveTextContent(/last read of this page failed/i);
      expect(note).toHaveTextContent(/not a statement that no cycle has run/i);
      expect(screen.queryByTestId("snapshot-ledger-never-enabled")).not.toBeInTheDocument();
      expect(screen.queryByTestId("snapshot-ledger-nothing-recorded")).not.toBeInTheDocument();
    });

    it("marks rows kept from an earlier load as possibly out of date", async () => {
      serveThenFail(withRuns([SKIPPED]));
      renderPage();
      await reloadAfterWrite();

      expect(await screen.findByTestId("snapshot-ledger-stale")).toHaveTextContent(
        /from an earlier load and may be out of date/i,
      );
      // The rows stay: withholding what we do have would be its own lie.
      expect(screen.getByTestId("snapshot-run-2026-08-15-skipped_disabled")).toBeInTheDocument();
    });

    it("hangs no ledger on a switch whose loop keeps no record", async () => {
      // The archive's loop is the only one whose cycles are durable. A ledger
      // under the drain would imply a record that does not exist.
      serve(listing());
      renderPage();

      await screen.findByText("Event drain");
      expect(screen.queryByTestId("snapshot-ledger")).not.toBeInTheDocument();
    });
  });

  it("renders a feature whose risk grade this build does not know", async () => {
    // A switch missing from this screen is a switch nobody knows exists.
    serve(listing([{ ...NARRATIVE, risk: "cataclysmic" }]));
    renderPage();

    const group = await screen.findByTestId("group-unknown");
    expect(within(group).getByText("Generated finding narrative")).toBeInTheDocument();
    expect(group).toHaveTextContent(/no words for/i);
  });
});
