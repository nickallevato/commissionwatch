import type { Knex } from "knex";
import knexConfig from "../../knexfile";

/**
 * Event-log hygiene for the test suite, and the cursor seeding two suites need.
 *
 * ## Why this file exists
 *
 * `events` is append-only by design. Migration 083 says so in as many words —
 * "Retention: never delete" — because those rows are the only record of what
 * this project told the public and when. That rule is load-bearing in
 * production and nothing here weakens it.
 *
 * It is also, in a *test* database, a slow-acting poison. `PrerenderConsumer`
 * and `EventDrain` both read a bounded batch in key order from wherever their
 * cursor stands, and the default batch is 200. Once the table holds more than a
 * batch of rows older than a suite's own fixtures, that suite's ticks spend
 * their whole batch on unrelated rows and never reach the fixtures. It has
 * already happened: 1,585 rows left by ad-hoc runs, and the assertion it broke
 * was `prerender.test.ts`'s "a withdrawn meeting kept its prerendered page" —
 * the worst report this system can produce, red for a reason with nothing to do
 * with the code under test. A suite that goes red for the environment on the
 * assertion that matters most teaches the next reader to disbelieve it.
 *
 * Seeding a cursor (below) treats the symptom. This file also treats the cause:
 * `reset-events.ts` clears the soil as `pretest`, and `assert-events-clean.ts`
 * fails the run as `posttest`, naming any suite that left rows behind.
 *
 * ## Why the truncate cannot escape the test database
 *
 * `assertTestDatabase` is four independent conditions, and the two that matter
 * are not statements about configuration:
 *
 *  1. `NODE_ENV` must be `test`.
 *  2. The database name is read from the **server**, with
 *     `select current_database()`, not from the config object the caller was
 *     constructed with. A pool built from a stale or edited config still
 *     answers with the database it is genuinely connected to, so this cannot be
 *     talked out of by anything short of connecting to the real thing.
 *  3. That name must equal the database in `knexfile.ts`'s `test` connection.
 *  4. That name must end in `_test`, regardless of what the config says — so
 *     pointing `TEST_DATABASE_URL` at production and re-running is refused by
 *     the shape of the name itself, not by a comparison the same edit moved.
 *
 * Condition 4 is the one that survives an attacker who is also editing the
 * config, and 2 is the one that survives an attacker who is only editing it.
 * Neither is a comment or a convention; both throw.
 */

/** Every event-log guard refuses unless the connected database ends in this. */
const TEST_DATABASE_SUFFIX = "_test";

/**
 * The database name in `knexfile.ts`'s `test` connection.
 *
 * Deliberately supports only the string (URL) form, because that is the only
 * form the knexfile has ever used. An object connection is a change to the
 * knexfile, and a change to the knexfile should have to come and read this.
 */
function configuredTestDatabase(): string {
  const connection = knexConfig.test.connection;
  if (typeof connection !== "string") {
    throw new Error(
      "test event guard: knexfile's test connection is not a URL string, so the " +
        "expected database name cannot be read from it. Refusing to touch events.",
    );
  }
  const name = new URL(connection).pathname.replace(/^\//, "");
  if (name === "") {
    throw new Error(
      `test event guard: no database name in the test connection URL. Refusing to touch events.`,
    );
  }
  return name;
}

/**
 * The same server, a database that is deliberately *not* the test one.
 *
 * `postgres` is created by every PostgreSQL server, including the CI service
 * container — `POSTGRES_DB` adds a database, it does not replace that one. The
 * host and credentials are taken from the test connection rather than
 * hardcoded, because CI reaches the database at `postgres:5432` and a developer
 * reaches it at `localhost:5432`; a hardcoded host would make the guard's own
 * test pass in one place and error in the other.
 */
export function nonTestConnectionUrl(): string {
  const connection = knexConfig.test.connection;
  if (typeof connection !== "string") {
    throw new Error("test event guard: the knexfile's test connection is not a URL string.");
  }
  const url = new URL(connection);
  url.pathname = "/postgres";
  return url.toString();
}

/**
 * Throw unless `db` is genuinely connected to the test database.
 *
 * Returns the connected database's name so a caller can report it.
 */
export async function assertTestDatabase(db: Knex): Promise<string> {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      `test event guard: NODE_ENV is ${JSON.stringify(process.env.NODE_ENV)}, not "test". ` +
        "Refusing to touch the event log.",
    );
  }

  const result = await db.raw<{ rows: Array<{ current_database: string }> }>(
    "select current_database()",
  );
  const actual = result.rows[0]?.current_database;
  if (actual === undefined) {
    throw new Error("test event guard: the server did not report a current database.");
  }

  if (!actual.endsWith(TEST_DATABASE_SUFFIX)) {
    throw new Error(
      `test event guard: connected to database ${JSON.stringify(actual)}, whose name does not ` +
        `end in ${JSON.stringify(TEST_DATABASE_SUFFIX)}. Migration 083 says the event log is ` +
        "never deleted; refusing.",
    );
  }

  const expected = configuredTestDatabase();
  if (actual !== expected) {
    throw new Error(
      `test event guard: connected to database ${JSON.stringify(actual)}, but the knexfile's ` +
        `test connection names ${JSON.stringify(expected)}. Refusing.`,
    );
  }

  return actual;
}

export interface LeakedEventGroup {
  event_type: string;
  subject_kind: string;
  count: number;
  /** One example, so the reader has something to grep the suites for. */
  sample_dedupe_key: string;
}

/** Every row currently in the event log, grouped for a readable failure. */
export async function leakedEvents(db: Knex): Promise<LeakedEventGroup[]> {
  const rows = await db("events")
    .select<Array<{ event_type: string; subject_kind: string; count: string; sample: string }>>(
      "event_type",
      "subject_kind",
    )
    .count("* as count")
    .min("dedupe_key as sample")
    .groupBy("event_type", "subject_kind")
    .orderBy("count", "desc");
  return rows.map((row) => ({
    event_type: row.event_type,
    subject_kind: row.subject_kind,
    count: Number(row.count),
    sample_dedupe_key: row.sample,
  }));
}

/**
 * Empty the event log in the test database. Refuses anywhere else.
 *
 * Returns the number of rows removed, so `pretest` can say how much soil it
 * found rather than silently tidying up.
 */
export async function truncateEvents(db: Knex): Promise<number> {
  await assertTestDatabase(db);
  const [row] = await db("events").count<Array<{ count: string }>>("* as count");
  const before = Number(row?.count ?? 0);
  await db.raw("TRUNCATE TABLE events");
  return before;
}

/** The part of a `PrerenderConsumer` this helper needs. */
export interface CursorWritable {
  writeCursor(cursor: { updated_at: string; id: string }): Promise<void>;
}

/**
 * Start a consumer where the calling suite's fixtures start, not at the
 * beginning of the log.
 *
 * Written exactly the way `tick` writes a cursor — same file, same
 * `(updated_at, id)` pair — positioned on the newest event that exists before
 * the suite emits any of its own. Everything the suite goes on to emit is
 * strictly later on both parts of that key, so it is read; nothing older is.
 * This bounds the work rather than changing what the consumer does, and a run
 * against an empty log behaves exactly as it did: with no rows there is no
 * cursor to write, and the consumer starts from NULL as before.
 *
 * Both `prerender.test.ts` and `feature-toggle-live.test.ts` hand-rolled this.
 * The block is subtle in a way that invites drift — order by *both* key parts,
 * descending, and serialise the timestamp the way the cursor file stores it —
 * and two copies of a subtle block is one copy waiting to be wrong.
 *
 * Returns the cursor written, or `null` when the log was empty.
 */
export async function seedCursorPastExistingEvents(
  db: Knex,
  consumer: CursorWritable,
): Promise<{ updated_at: string; id: string } | null> {
  const latest = await db("events")
    .orderBy([
      { column: "updated_at", order: "desc" },
      { column: "id", order: "desc" },
    ])
    .first<{ id: string; updated_at: Date | string } | undefined>("id", "updated_at");
  if (latest === undefined) return null;

  const cursor = {
    updated_at:
      latest.updated_at instanceof Date
        ? latest.updated_at.toISOString()
        : String(latest.updated_at),
    id: latest.id,
  };
  await consumer.writeCursor(cursor);
  return cursor;
}
