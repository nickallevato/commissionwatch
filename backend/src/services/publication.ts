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

/** Constrains a `meetings` query to rows an operator has published. */
export function whereMeetingPublished<T extends Knex.QueryBuilder>(query: T): T {
  query.whereNotNull("published_at");
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
