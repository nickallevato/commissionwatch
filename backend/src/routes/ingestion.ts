import { Router } from "express";
import db from "../config/database";
import { buildPublicStatus } from "../services/ingestion-status";

/**
 * The public, read-only view of when this site last fetched anything.
 *
 * It exists because the masthead used to say "Last sweep 12 min ago" from a
 * constant. That was harmless while the database was empty and became a false
 * statement on a transparency site the moment real rows landed. A site that
 * reports on other people's record-keeping does not get to make up its own
 * timestamps, so the number now comes from `ingestion_runs` or is not shown.
 *
 * `partial` counts as a sweep that happened: work reached the database. It is
 * the same rule `SourceScheduler.updateSourceHealth` applies to
 * `last_success_at`, and the two must not disagree about what a successful
 * sweep is.
 *
 * `null` means no sweep has ever succeeded, which is a fact worth publishing
 * rather than a gap worth filling.
 */

const router = Router();

/** The statuses that count as a sweep having reached the database. */
export const SWEPT_STATUSES = ["succeeded", "partial"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The newest `finished_at` of any run that landed work, or null. */
export async function readLastSuccessfulSweep(): Promise<string | null> {
  const row: unknown = await db("ingestion_runs")
    .whereIn("status", [...SWEPT_STATUSES])
    .whereNotNull("finished_at")
    .max({ finished_at: "finished_at" })
    .first();
  if (!isRecord(row)) return null;
  const finishedAt = row.finished_at;
  if (finishedAt instanceof Date) return finishedAt.toISOString();
  // knex returns a string for a timestamptz on some driver configurations.
  if (typeof finishedAt === "string" && finishedAt !== "") {
    const parsed = new Date(finishedAt);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

router.get("/status", async (_req, res, next) => {
  try {
    res.json({ lastSuccessfulSweepAt: await readLastSuccessfulSweep() });
  } catch (error) {
    next(error);
  }
});

/**
 * Every registered source, for the public status page.
 *
 * Public and unauthenticated on purpose: this describes *our* ingestion, not
 * anybody's record, and a reader is entitled to know whether the thing
 * reporting on their city's record-keeping is itself working. Nothing here
 * reads `meetings`, and the projection carries figures rather than text — see
 * `services/ingestion-status.ts` for why the run's error string stops at the
 * console.
 */
router.get("/sources", async (_req, res, next) => {
  try {
    const status = await buildPublicStatus(db);
    res.json({ ...status, total: status.sources.length });
  } catch (error) {
    next(error);
  }
});

export default router;
