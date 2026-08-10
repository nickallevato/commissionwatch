import type { Knex } from "knex";

/**
 * The wall between ingested and published.
 *
 * A meeting exists the moment a sweep finds it. It becomes public when an
 * operator says so, and `meetings.published_at` records when. Until then it is
 * a candidate: real, stored, citable inside the console, and absent from every
 * public response.
 *
 * That absence has to be one rule in one place. The public meetings router has
 * seven routes and the anomalies router has three more, and a rule re-typed ten
 * times is a rule that will be nine-tenths true after the next change. So both
 * routers reach for the helpers below, and `meeting-publication.test.ts` walks
 * every public path that takes a meeting id and asserts an unpublished meeting
 * is invisible on all of them.
 *
 * This is deliberately *not* implemented as a database view or an RLS policy.
 * The operator console reads the same tables and must see the unpublished rows;
 * a mechanism that hid them from every reader would hide them from the person
 * whose job is to decide.
 */

/**
 * Constrains a `meetings` query to rows an operator has published.
 *
 * `column` exists for the joined queries P6's search builds: a search over
 * agenda items reaches the wall through `meetings`, which is not the query's
 * own table, and an unqualified `published_at` in a four-table join is a column
 * reference waiting to become ambiguous. Passing the qualified name is how those
 * paths use *this* rule rather than retyping it as a `whereRaw`.
 */
export function whereMeetingPublished<T extends Knex.QueryBuilder>(
  query: T,
  column = "published_at",
): T {
  query.whereNotNull(column);
  return query;
}

/**
 * A published meeting by id, or `undefined`.
 *
 * `undefined` covers both "no such meeting" and "not published yet", and the
 * callers turn both into the same 404. That is intentional: distinguishing them
 * would let an anonymous caller enumerate what has been ingested but withheld,
 * which is precisely the state an operator has not finished deciding about.
 */
export async function findPublishedMeeting(
  db: Knex,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const row: unknown = await db("meetings").where({ id }).whereNotNull("published_at").first();
  return typeof row === "object" && row !== null ? (row as Record<string, unknown>) : undefined;
}

/* ---------------------------------------------------------------------------
   Findings — B-a's half of the same wall.
   --------------------------------------------------------------------------- */

/**
 * Constrains an `anomaly_flags` query to findings a reader may see.
 *
 * Two conditions, and both are load-bearing:
 *
 *  - **`review_state = 'published'`.** Until B-a there was no code path that
 *    ever set this, so `held` meant held forever. Approval by a named operator
 *    is now the only thing that changes it, which is what makes "nothing naming
 *    a person auto-publishes" a mechanism rather than an aspiration. A
 *    *rejected* finding is left `held`, so rejection needs no separate rule
 *    here — it simply never becomes publishable.
 *
 *  - **A meeting-derived finding needs a published meeting.** This closes a
 *    hole that predates the queue: `GET /api/anomalies` filtered on
 *    `review_state` alone, so an auto-published flag on a meeting an operator
 *    had not published leaked both the meeting's existence and a sentence of
 *    its content — through the one public route that does not take a meeting id
 *    and therefore cannot be reached only by guessing one. A flag with no
 *    meeting is a records-derived flag about an artifact; it has no meeting to
 *    be published, and requiring one would make it permanently invisible rather
 *    than merely unapproved.
 *
 * `table` names the flags table for a joined query, the same reason
 * `whereMeetingPublished` takes a column.
 */
export function whereFindingPublic<T extends Knex.QueryBuilder>(
  db: Knex,
  query: T,
  table = "anomaly_flags",
): T {
  query.where(`${table}.review_state`, "published").where((builder) => {
    builder
      .whereNull(`${table}.meeting_id`)
      .orWhereExists(
        db("meetings")
          .whereRaw(`meetings.id = ${table}.meeting_id`)
          .whereNotNull("meetings.published_at"),
      );
  });
  return query;
}

/**
 * A publicly visible finding by id, or `undefined`.
 *
 * `undefined` covers "no such flag", "not approved" and "its meeting is not
 * published", and every caller turns all three into the same 404 — for the
 * reason `findPublishedMeeting` gives. Distinguishing them would let anyone
 * enumerate what has been detected and withheld, which on this table is a
 * generated claim about a named person awaiting a human decision.
 */
export async function findPublicFinding(
  db: Knex,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const query = db("anomaly_flags").where("anomaly_flags.id", id).select("anomaly_flags.*");
  const row: unknown = await whereFindingPublic(db, query).first();
  return typeof row === "object" && row !== null ? (row as Record<string, unknown>) : undefined;
}
