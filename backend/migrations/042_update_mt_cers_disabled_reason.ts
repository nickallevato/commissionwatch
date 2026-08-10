import type { Knex } from "knex";

/**
 * The `mt-cers` row's `disabled_reason` stopped being true.
 *
 * Migration 037 created it saying "No adapter has been written for this source
 * yet", which was exactly right at the time and is published verbatim on the
 * **public** status page. An adapter now exists, so leaving that sentence up
 * would put a false statement about our own ingestion on the page whose entire
 * purpose is that absences are visible and honest.
 *
 * `registerSource` cannot fix this: it writes `disabled_reason` only when it
 * *creates* the row, deliberately, so that an operator's edits are not reverted
 * on the next deploy. A row created by 037 and never re-created therefore keeps
 * 037's text forever unless something says otherwise. This says otherwise, once.
 *
 * The source stays **disabled**. Nothing here enables anything: an adapter
 * existing is not a decision to sweep, and enabling a source remains an
 * operator action.
 *
 * It matches on the old text rather than on the key alone, so an operator who
 * has already written their own reason keeps it.
 */

const ADAPTER_KEY = "mt-cers";

const OLD_REASON_PREFIX = "No adapter has been written for this source yet.";

const NEW_REASON =
  "Disabled pending an operator decision, not blocked. The adapter exists and has run: Montana " +
  "campaign finance (CERS, cers-ext.mt.gov/CampaignTracker) is reachable with no access " +
  "exception of any kind — the host publishes no robots.txt at all, there is no login and no " +
  "CAPTCHA, and the honest project user agent is served normally. There is no bulk download, " +
  "CSV or documented API, so records are read one filing at a time from a session-scoped JSON " +
  "API at one request every two seconds, scoped to Gallatin County by county code and campaign " +
  "type. Enabling it is a deliberate act, as it is for every source. See " +
  "docs/exploration/mt-cers-spike.md.";

export async function up(knex: Knex): Promise<void> {
  await knex("ingestion_sources")
    .where({ adapter_key: ADAPTER_KEY })
    .whereLike("disabled_reason", `${OLD_REASON_PREFIX}%`)
    .update({ disabled_reason: NEW_REASON, updated_at: knex.fn.now() });
}

export async function down(knex: Knex): Promise<void> {
  // Restores only what 037 wrote, and only where this migration's text is still
  // in place, so an operator's own wording is never clobbered by a rollback.
  await knex("ingestion_sources")
    .where({ adapter_key: ADAPTER_KEY, disabled_reason: NEW_REASON })
    .update({
      disabled_reason:
        "No adapter has been written for this source yet. Montana campaign-finance filings are " +
        "published through CERS (cers-ext.mt.gov/CampaignTracker), a structured system rather " +
        "than a document archive, and reading it is a separate piece of work that has not been " +
        "done. This row exists so that the absence is visible on the public status page rather " +
        "than being invisible: nothing has ever been ingested from Montana campaign finance, " +
        "and no figure on this site draws on it.",
      updated_at: knex.fn.now(),
    });
}
