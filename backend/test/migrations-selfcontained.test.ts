import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createDecipheriv } from "node:crypto";
import { encryptConfig } from "../src/services/delivery/crypto";
import db from "../src/config/database";

/**
 * Migrations run inside the production image, and that image does not contain
 * application source. `backend/Dockerfile` copies `dist/` and `migrations/`,
 * never `src/` — so a migration importing `../src/...` resolves on every
 * developer machine, passes every test, builds a clean image, and then dies at
 * module load in the container.
 *
 * That is exactly what happened on 2026-08-09: migration 025 imported
 * `../src/services/delivery/crypto`, the entrypoint runs `knex migrate:latest`
 * under `set -e`, the server never started, and `restart: unless-stopped`
 * retried the same failure. Production served 502 for hours while every local
 * check was green, because nothing local can see an image layout.
 *
 * This test is the guard. It is deliberately a source scan rather than a
 * behavioural test: the failure mode is a module resolution that only differs
 * between two filesystem layouts, so no amount of running the migration here
 * would reproduce it.
 */

// `__dirname`, not `import.meta.dirname`: tsx transpiles this suite to
// CommonJS, where the latter is undefined.
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

/** Only these may be imported by a migration. Everything else ships nowhere. */
const ALLOWED_BARE = new Set(["knex"]);

function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /^\s*import\s[^'"]*from\s*['"]([^'"]+)['"]/gm,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) specs.push(m[1]);
  }
  return specs;
}

describe("migrations are self-contained", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".ts"));

  it("finds migrations to check", () => {
    // A scan that silently matched nothing would pass forever.
    assert.ok(files.length > 30, `expected the migration set, found ${files.length}`);
  });

  it("no migration reaches outside the migrations directory", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      for (const spec of importSpecifiers(source)) {
        const isRelative = spec.startsWith(".");
        const escapes = isRelative && spec.startsWith("..");
        const isNodeBuiltin = spec.startsWith("node:");
        const isAllowedBare = !isRelative && !isNodeBuiltin && ALLOWED_BARE.has(spec);

        if (escapes) {
          offenders.push(`${file} imports ${spec}`);
        } else if (!isRelative && !isNodeBuiltin && !isAllowedBare) {
          offenders.push(`${file} imports non-shipped package ${spec}`);
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      "A migration imported something the production image does not contain.\n" +
        "backend/Dockerfile copies dist/ and migrations/, never src/.\n" +
        "Inline what you need using node: builtins instead.\n" +
        offenders.join("\n"),
    );
  });
});

/**
 * The encryption envelope is duplicated between migration 025 and
 * `src/services/delivery/crypto.ts` — unavoidably, since the migration cannot
 * import it. Duplication is only safe while the two agree, so assert it: the
 * application must be able to read what the migration writes.
 */
describe("migration 025's inlined envelope matches the application's", () => {
  const KEY = "a".repeat(64); // 32 bytes of hex

  it("produces a payload the application's decrypt path accepts", () => {
    const previous = process.env.CHANNEL_SECRET_KEY;
    process.env.CHANNEL_SECRET_KEY = KEY;
    try {
      const payload = encryptConfig({ email: "someone@example.invalid" }, KEY);

      // Same layout the migration writes: version, iv, tag, ciphertext.
      assert.equal(payload[0], 1, "version byte");
      const iv = payload.subarray(1, 13);
      const tag = payload.subarray(13, 29);
      const ciphertext = payload.subarray(29);

      const decipher = createDecipheriv("aes-256-gcm", Buffer.from(KEY, "hex"), iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString("utf8");

      assert.deepEqual(JSON.parse(plain), { email: "someone@example.invalid" });
    } finally {
      if (previous === undefined) delete process.env.CHANNEL_SECRET_KEY;
      else process.env.CHANNEL_SECRET_KEY = previous;
    }
  });
});


/**
 * A CHECK constraint that can evaluate to NULL is satisfied.
 *
 * So a constraint shaped `A OR (B AND C)`, where A can be FALSE and B or C touch
 * a nullable column, enforces nothing — and the row it lets through is the one
 * that violates it hardest, the one with the columns simply absent.
 *
 * Four of these shipped in a single day before anyone noticed the class:
 *
 *  - `vote_events.counts` accepted exactly the malformed tally it existed to
 *    refuse, because `jsonb_typeof(counts -> 'absent')` is NULL for a missing
 *    key.
 *  - `place_links_citation_check` let a `stated` link insert with no citation at
 *    all, and stayed invisible for hours because nothing had ever written to the
 *    table. The first writer found it on its first run.
 *  - `minute_claims_approved_pin_check` would have let an approved claim carry
 *    no render pin — the pin being the whole guarantee that a later template
 *    edit cannot republish words nobody read.
 *  - `transcript_status_sha_check` would have let a published transcript carry
 *    no hash of the bytes it claims to have read.
 *
 * None of the last two had bitten, because their writers happen to set the
 * columns. That is the reason to have this test rather than to have fixed them
 * and moved on: a constraint that is true only by the good manners of its one
 * caller fails the day a second caller appears.
 *
 * The distinction the query encodes matters. `X IS NULL OR …` is safe — `IS
 * NULL` returns true or false and never NULL. The hazard is a comparison that
 * can be FALSE on the left with a nullable operand on the right, which is why
 * the allow-list below is by constraint name rather than by pattern: a pattern
 * broad enough to exempt the safe ones would exempt the dangerous ones too.
 */
describe("CHECK constraints cannot pass by evaluating to NULL", () => {
  /**
   * Constraints whose right-hand side touches only NOT NULL columns, so no
   * NULL can reach the expression. Each is a decision someone made by reading
   * the column definitions, not a pattern match.
   */
  /**
   * Two shapes are provably null-safe, and each is justified rather than
   * assumed. Everything else must be `coalesce`-guarded or named below.
   *
   * **Leading null test** — `X IS NULL OR f(X)`. If X is NULL the left disjunct
   * is TRUE and the constraint is satisfied honestly; if X is not NULL then
   * `f(X)` sees a real value. The safety comes from the guard being *first* and
   * about the same column the rest tests.
   *
   * **Null tests only on the right** — `A OR (X IS NOT NULL AND Y IS NULL)`.
   * `IS NULL` and `IS NOT NULL` return true or false however null their operand
   * is, so no NULL can reach the OR from that side.
   *
   * A regex broad enough to cover both *and* the dangerous shape is what let
   * four of these ship, so these two are deliberately narrow and anything they
   * do not match needs a human.
   */
  const LEADING_NULL_TEST = /^CHECK\s*\(*\(\(?[\w.]+\)?(::[\w ]+)?\s+IS\s+NULL\)\s+OR\s/i;
  const RIGHT_IS_NULL_TESTS_ONLY =
    /\bOR\s+\(*\(?[\w.()":]+\)?(::[\w ]+)?\s+IS\s+(NOT\s+)?NULL\)?(\s+AND\s+\(?[\w.()":]+\)?(::[\w ]+)?\s+IS\s+(NOT\s+)?NULL\)?)*\)*\s*$/i;

  /**
   * The remainder, exempted by name after reading the column definitions.
   * **Not a pattern** — any regex loose enough to cover these would cover the
   * dangerous shape too, which is exactly how the class went unnoticed.
   */
  const NULL_SAFE: Readonly<Record<string, string>> = {
    // `supported` and `unsupported_fragments` are both NOT NULL (migration 093).
    claim_verdicts_points_at_something_check: "every operand is NOT NULL",
    // `disclosure_required` is NOT NULL (migration 074).
    jurisdiction_access_policy_exception_is_disclosed: "every operand is NOT NULL",
    // Two independent leading-null-test disjuncts joined by AND; each half is
    // the safe shape, and the AND of two non-NULL booleans is never NULL.
    jurisdiction_records_law_days_check: "two leading null tests, ANDed",
  };

  it("guards every disjunctive constraint with coalesce, or exempts it by name", async () => {
    const rows = await db.raw<{
      rows: Array<{ table_name: string; conname: string; def: string }>;
    }>(`
      select c.conrelid::regclass::text as table_name,
             c.conname                  as conname,
             pg_get_constraintdef(c.oid) as def
        from pg_constraint c
       where c.contype = 'c'
         and c.connamespace = 'public'::regnamespace
         and pg_get_constraintdef(c.oid) ilike '%or %'
         and pg_get_constraintdef(c.oid) not ilike '%coalesce%'
       order by 1, 2
    `);

    const unguarded = rows.rows.filter((row) => {
      if (NULL_SAFE[row.conname] !== undefined) return false;
      if (LEADING_NULL_TEST.test(row.def)) return false;
      if (RIGHT_IS_NULL_TESTS_ONLY.test(row.def)) return false;
      return true;
    });

    assert.deepEqual(
      unguarded.map((row) => `${row.table_name}.${row.conname}`),
      [],
      "a CHECK evaluating to NULL is satisfied; wrap the disjunct in coalesce(..., false) " +
        "or add it to NULL_SAFE with the reason no NULL can reach the expression",
    );
  });
});

/**
 * File scope. node:test runs a describe's `after` as soon as that block
 * finishes, so pool teardown inside the first one kills every suite below it —
 * this file has been bitten by that shape twice elsewhere in the repo.
 */
after(async () => {
  await db.destroy();
});
