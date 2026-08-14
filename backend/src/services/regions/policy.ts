import type { Knex } from "knex";

/**
 * The regions module — reading the per-jurisdiction access policy, and judging
 * it.
 *
 * `migrations/074_create_jurisdiction_access_policy.ts` holds the reasoning for
 * why these facts are a table. This module is the half that makes them do
 * something: a sweep asks what it is allowed to do, and the console and the
 * public status page ask whether we are still keeping the promises we made.
 *
 * Every judgement here is derived at read time. Nothing writes a verdict to a
 * column, for the same reason B-a's review queue derives "overdue" rather than
 * storing it: a status written by a clock reads, later, exactly like a decision
 * somebody made.
 */

/** How long a stated posture stands before somebody should re-read it. */
export const POSTURE_STALE_AFTER_DAYS = 365;

export type RobotsPosture = "respect" | "vendor_exception" | "blocked";

export interface AccessPolicy {
  jurisdiction_id: string;
  vendor_platform: string | null;
  robots_posture: RobotsPosture;
  disclosure_required: boolean;
  crawl_delay_seconds: number;
  max_concurrency: number;
  user_agent: string | null;
  tos_notes: string | null;
  notes: string | null;
  verified_on: Date | string;
  verified_by: string | null;
}

export interface PostureVerdict {
  /** May a sweep run against this region at all? */
  fetchable: boolean;
  /** Has the stated posture gone unread long enough to need re-checking? */
  stale: boolean;
  daysSinceVerified: number | null;
  /** One sentence, safe to publish. Never names a person or an internal URL. */
  summary: string;
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

/**
 * The absence of a row is a refusal, not a default.
 *
 * A missing policy means nobody has decided how this place may be treated, and
 * the safe reading of that is "do not fetch" rather than "fetch politely". The
 * alternative — falling back to a sensible default — is how a jurisdiction
 * added by a future migration would quietly start being crawled under a policy
 * no human ever agreed to.
 */
export function assessPosture(
  policy: AccessPolicy | undefined,
  now: Date = new Date(),
): PostureVerdict {
  if (!policy) {
    return {
      fetchable: false,
      stale: false,
      daysSinceVerified: null,
      summary: "No access policy recorded. Nothing is fetched from this jurisdiction.",
    };
  }

  const verifiedOn =
    policy.verified_on instanceof Date ? policy.verified_on : new Date(policy.verified_on);
  const days = Number.isNaN(verifiedOn.getTime()) ? null : daysBetween(verifiedOn, now);
  const stale = days !== null && days > POSTURE_STALE_AFTER_DAYS;

  if (policy.robots_posture === "blocked") {
    return {
      fetchable: false,
      stale,
      daysSinceVerified: days,
      summary:
        "Not reachable by acceptable means. Records from this jurisdiction are obtained by "
        + "public-records request instead.",
    };
  }

  // The database CHECK makes this unreachable, and it is asserted anyway. The
  // constraint protects the table; this protects the sweep against a row that
  // arrived some other way — a restore from an older dump, a hand-edited
  // staging database. An undisclosed exception is the one failure here with a
  // consequence outside this codebase.
  if (policy.robots_posture === "vendor_exception" && !policy.disclosure_required) {
    return {
      fetchable: false,
      stale,
      daysSinceVerified: days,
      summary:
        "A robots exception is claimed without the disclosure that makes it legitimate. "
        + "Nothing is fetched until that is resolved.",
    };
  }

  const politeness = `one request every ${policy.crawl_delay_seconds}s, `
    + `${policy.max_concurrency} at a time`;

  return {
    fetchable: true,
    stale,
    daysSinceVerified: days,
    summary:
      policy.robots_posture === "vendor_exception"
        ? `Fetched under a disclosed vendor-robots exception at ${politeness}.`
        : `robots.txt is respected. Fetched at ${politeness}.`,
  };
}

export async function loadAccessPolicy(
  db: Knex,
  jurisdictionId: string,
): Promise<AccessPolicy | undefined> {
  return db<AccessPolicy>("jurisdiction_access_policy")
    .where({ jurisdiction_id: jurisdictionId })
    .first();
}

export interface RegionPosture extends PostureVerdict {
  jurisdiction_id: string;
  jurisdiction_name: string;
  vendor_platform: string | null;
  robots_posture: RobotsPosture | null;
  verified_on: string | null;
}

/**
 * Every jurisdiction with its posture, including the ones that have none.
 *
 * A left join, deliberately. A jurisdiction missing a policy row is exactly
 * what this listing exists to surface, so an inner join would hide the only
 * rows that need action — the same defect P7's console had when it selected
 * `law.jurisdiction_id` and every jurisdiction *without* a law row came back
 * with a null id and vanished from the page.
 */
export async function listRegionPostures(
  db: Knex,
  now: Date = new Date(),
): Promise<RegionPosture[]> {
  const rows = await db("jurisdictions as j")
    .leftJoin("jurisdiction_access_policy as p", "p.jurisdiction_id", "j.id")
    .select(
      "j.id as jurisdiction_id",
      "j.name as jurisdiction_name",
      "p.vendor_platform",
      "p.robots_posture",
      "p.disclosure_required",
      "p.crawl_delay_seconds",
      "p.max_concurrency",
      "p.user_agent",
      "p.tos_notes",
      "p.notes",
      "p.verified_on",
      "p.verified_by",
    )
    .orderBy("j.name");

  return rows.map((row) => {
    const policy = row.robots_posture
      ? ({
          jurisdiction_id: row.jurisdiction_id,
          vendor_platform: row.vendor_platform,
          robots_posture: row.robots_posture,
          disclosure_required: row.disclosure_required,
          crawl_delay_seconds: row.crawl_delay_seconds,
          max_concurrency: row.max_concurrency,
          user_agent: row.user_agent,
          tos_notes: row.tos_notes,
          notes: row.notes,
          verified_on: row.verified_on,
          verified_by: row.verified_by,
        } satisfies AccessPolicy)
      : undefined;

    const verdict = assessPosture(policy, now);
    const verifiedOn =
      row.verified_on instanceof Date
        ? row.verified_on.toISOString().slice(0, 10)
        : (row.verified_on ?? null);

    return {
      jurisdiction_id: row.jurisdiction_id,
      jurisdiction_name: row.jurisdiction_name,
      vendor_platform: row.vendor_platform ?? null,
      robots_posture: row.robots_posture ?? null,
      verified_on: verifiedOn,
      ...verdict,
    };
  });
}
