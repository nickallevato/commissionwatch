import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Set before anything imports `src/app` — `signInOperator` does, and the app
// pulls in the event spine's dispatcher config, which resolves this key at module
// load. Same reason `roster-console.test.ts` and `place-review.test.ts` set it at
// the top of the file.
process.env.CHANNEL_SECRET_KEY =
  process.env.CHANNEL_SECRET_KEY ??
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import request from "supertest";

import app from "../src/app";
import db from "../src/config/database";
import {
  FEATURES,
  featureKeys,
  findFeatureDefinition,
  isFeatureKey,
  killSwitchEnvName,
} from "../src/services/features/manifest";
import {
  DEFAULT_FEATURE_POLL_INTERVAL_MS,
  FeatureRegistry,
  FeatureRegistryError,
  featureEnabled,
  featurePollIntervalMs,
  killSwitchForcesOff,
  resolveFeature,
  setFeatureRegistry,
} from "../src/services/features/registry";
import { mcpEnabled } from "../src/routes/mcp";
import { EventDrain } from "../src/services/events/drain";
import { PrerenderConsumer } from "../src/services/prerender/consumer";
import { signInOperator } from "./helpers/pressroom";

/**
 * The feature registry: what decides a switch, in what order, and what it costs
 * to change one.
 *
 * What this suite holds:
 *
 *  - **the four steps resolve in order, and every failure falls off.** No row, no
 *    variable, no database — off. That is the property that lets a capability ship
 *    dark and be evaluated later rather than on merge;
 *  - **the kill switch outranks the database, one-directionally.** `FEATURE_*=false`
 *    wins over a row saying on, because the scenario that most demands turning a
 *    feature off is the one where the feature is hammering Postgres. A truthy
 *    `FEATURE_*` enables nothing, because an enable that carries no operator and
 *    no reason is the thing this design exists to remove;
 *  - **a row for a key this build does not ship is inert.** That row is what a
 *    rolled-back deploy leaves behind, and a rollback that trips an error is not
 *    a rollback;
 *  - **every write is a change, and every change has a reason and an actor.** A
 *    no-op is refused so the log reads as a list of decisions rather than clicks,
 *    and the switch and its audit row commit together or not at all;
 *  - **writing `false` where no row exists is a change.** Off-by-default and
 *    off-by-decision are different facts, and the second is the write that
 *    overrides a legacy variable still saying on.
 *
 * The route's own contract — the status code for each refusal — is at the bottom.
 * `feature-registry-audit.test.ts` holds the separate and larger property: that
 * no key in here can gate a wall.
 */

const OPERATOR_EMAIL = "features-test@example.com";

/** Cleaned rather than scoped: `features` is keyed by manifest key, so there is
 *  no prefix to hide behind and no other suite writes it. `not_a_feature` is the
 *  inert row this suite inserts on purpose. */
const TOUCHED_KEYS = [...featureKeys(), "not_a_feature"];

let cookie: string;
let operatorId: string;

async function clearFlags(): Promise<void> {
  await db("features_audit").whereIn("key", TOUCHED_KEYS).del();
  await db("features").whereIn("key", TOUCHED_KEYS).del();
}

before(async () => {
  cookie = await signInOperator(OPERATOR_EMAIL, "Features Test");
  const row = await db("operators")
    .where({ email: OPERATOR_EMAIL })
    .first<{ id: string } | undefined>("id");
  assert.ok(row, "sign-in left no operator row");
  operatorId = row.id;
  await clearFlags();
});

after(async () => {
  await clearFlags();
  await db("operators").where({ email: OPERATOR_EMAIL }).del();
  // The module singleton is process-wide. Left installed, it would decide flags
  // for anything else this process imports.
  setFeatureRegistry(null);
  await db.destroy();
});

beforeEach(async () => {
  await clearFlags();
  setFeatureRegistry(null);
});

/* --------------------------------------------------------------------------
   Resolution with no registry: the state every process starts in
   -------------------------------------------------------------------------- */

describe("resolution with nothing installed", () => {
  it("defaults every manifest key to off, with source `default`", () => {
    for (const key of featureKeys()) {
      const resolution = resolveFeature(key, {});
      assert.equal(resolution.enabled, false, key);
      assert.equal(resolution.source, "default", key);
      // Null, not a date. "The switch says on" and "this process has confirmed
      // the switch says on" are different facts and the console must not
      // conflate them.
      assert.equal(resolution.loadedAt, null, key);
    }
  });

  it("honours a legacy variable on the values it always honoured", () => {
    assert.equal(featureEnabled("event_drain", { EVENT_DRAIN_ENABLED: "true" }), true);
    assert.equal(featureEnabled("event_drain", { EVENT_DRAIN_ENABLED: " On " }), true);
    assert.equal(featureEnabled("prerender", { PRERENDER_ENABLED: "1" }), true);
    assert.equal(featureEnabled("event_drain", { EVENT_DRAIN_ENABLED: "" }), false);
    assert.equal(featureEnabled("event_drain", { EVENT_DRAIN_ENABLED: "false" }), false);
  });

  it("reports `EVENT_DRAIN_ENABLED=false` as `default`, not `legacy-env`", () => {
    // Same value by a shorter road, and the honest source: nothing enabled it.
    // The console shows this string to an operator, so it has to be true.
    assert.equal(resolveFeature("event_drain", { EVENT_DRAIN_ENABLED: "false" }).source, "default");
  });

  it("has no legacy variable for the keys that never had one", () => {
    for (const key of ["claim_publication", "generated_narrative", "dated_export_archive"]) {
      const definition = findFeatureDefinition(key);
      assert.ok(definition, key);
      assert.equal(definition.legacyEnv, null, key);
    }
  });

  it("lets the kill switch force a feature off over its legacy variable", () => {
    const resolution = resolveFeature("event_drain", {
      EVENT_DRAIN_ENABLED: "true",
      FEATURE_EVENT_DRAIN: "false",
    });
    assert.equal(resolution.enabled, false);
    assert.equal(resolution.source, "kill-switch");
  });

  it("accepts every falsey spelling of the kill switch", () => {
    for (const value of ["false", "0", "no", "off", "OFF", " False "]) {
      assert.equal(killSwitchForcesOff("event_drain", { FEATURE_EVENT_DRAIN: value }), true, value);
    }
  });

  it("is one-directional: a truthy kill switch enables nothing", () => {
    // The one property that keeps every enable traceable. If `FEATURE_*=true`
    // worked, the untraceable enable this design removes would be back and would
    // be the easiest path.
    for (const value of ["true", "1", "yes", "on"]) {
      const resolution = resolveFeature("mcp_server", { FEATURE_MCP_SERVER: value });
      assert.equal(resolution.enabled, false, value);
      assert.equal(resolution.source, "default", value);
      assert.equal(killSwitchForcesOff("mcp_server", { FEATURE_MCP_SERVER: value }), false, value);
    }
  });

  it("derives the kill-switch name from the key", () => {
    // Derived rather than declared, so a new manifest entry cannot ship with a
    // working switch and a wrong variable name in the deploy docs.
    assert.equal(killSwitchEnvName("event_drain"), "FEATURE_EVENT_DRAIN");
    assert.equal(killSwitchEnvName("mcp_server"), "FEATURE_MCP_SERVER");
  });

  it("falls back to the default poll interval rather than to zero", () => {
    assert.equal(featurePollIntervalMs({}), DEFAULT_FEATURE_POLL_INTERVAL_MS);
    // A typo in a deploy config must not be the thing that stops toggles
    // propagating, and must not be the thing that opens a query per millisecond.
    assert.equal(featurePollIntervalMs({ FEATURE_POLL_INTERVAL_MS: "nonsense" }), DEFAULT_FEATURE_POLL_INTERVAL_MS);
    assert.equal(featurePollIntervalMs({ FEATURE_POLL_INTERVAL_MS: "0" }), DEFAULT_FEATURE_POLL_INTERVAL_MS);
    assert.equal(featurePollIntervalMs({ FEATURE_POLL_INTERVAL_MS: "-5" }), DEFAULT_FEATURE_POLL_INTERVAL_MS);
    assert.equal(featurePollIntervalMs({ FEATURE_POLL_INTERVAL_MS: "250" }), 250);
  });
});

/* --------------------------------------------------------------------------
   Resolution against the table
   -------------------------------------------------------------------------- */

describe("resolution against a loaded registry", () => {
  const silent = { warn: () => {}, error: () => {} };

  it("resolves a row it has read, and reports the source as `registry`", async () => {
    await db("features").insert({ key: "mcp_server", enabled: true });
    const registry = new FeatureRegistry(db, { env: {}, logger: silent });
    await registry.refresh();

    const resolution = registry.resolve("mcp_server");
    assert.equal(resolution.enabled, true);
    assert.equal(resolution.source, "registry");
    assert.ok(resolution.loadedAt instanceof Date);
  });

  it("resolves a row saying off over a legacy variable saying on", async () => {
    // The whole reason writing `false` where no row exists is not a no-op: this
    // is the write that overrides a deploy config nobody has edited yet.
    await db("features").insert({ key: "event_drain", enabled: false });
    const registry = new FeatureRegistry(db, {
      env: { EVENT_DRAIN_ENABLED: "true" },
      logger: silent,
    });
    await registry.refresh();

    assert.equal(registry.get("event_drain"), false);
    assert.equal(registry.resolve("event_drain").source, "registry");
  });

  it("lets the kill switch outrank a row saying on", async () => {
    await db("features").insert({ key: "event_drain", enabled: true });
    const registry = new FeatureRegistry(db, {
      env: { FEATURE_EVENT_DRAIN: "false" },
      logger: silent,
    });
    await registry.refresh();

    const resolution = registry.resolve("event_drain");
    assert.equal(resolution.enabled, false);
    assert.equal(resolution.source, "kill-switch");
    // The row is still there and still says on. The environment is overriding
    // it, not deleting the decision.
    const row = await db("features").where({ key: "event_drain" }).first<{ enabled: boolean }>("enabled");
    assert.equal(row.enabled, true);
  });

  it("resolves off before it has loaded, even with a row saying on", async () => {
    await db("features").insert({ key: "prerender", enabled: true });
    const registry = new FeatureRegistry(db, { env: {}, logger: silent });

    // No refresh. A process that has not read the table has confirmed nothing,
    // and must not treat the absence of a cached row as a row saying on — or as
    // a row saying off, which is why the source is `default`.
    const resolution = registry.resolve("prerender");
    assert.equal(resolution.enabled, false);
    assert.equal(resolution.source, "default");
    assert.equal(resolution.loadedAt, null);
  });

  it("ignores a row naming a key this build does not ship", async () => {
    await db("features").insert({ key: "not_a_feature", enabled: true });
    const registry = new FeatureRegistry(db, { env: {}, logger: silent });
    await registry.refresh();

    assert.equal(isFeatureKey("not_a_feature"), false);
    assert.equal(findFeatureDefinition("not_a_feature"), null);
    // Inert: it resolves nothing, errors nowhere, and does not appear on the
    // console's list. That is what a rolled-back deploy needs.
    assert.equal(registry.resolveAll().length, FEATURES.length);
    assert.ok(!registry.resolveAll().some((entry) => entry.definition.key === "not_a_feature"));
  });

  it("drops a deleted row rather than keeping the last value it saw", async () => {
    await db("features").insert({ key: "mcp_server", enabled: true });
    const registry = new FeatureRegistry(db, { env: {}, logger: silent });
    await registry.refresh();
    assert.equal(registry.get("mcp_server"), true);

    await db("features").where({ key: "mcp_server" }).del();
    await registry.refresh();
    // Back to `default`, not stuck on the stale `registry` answer.
    assert.equal(registry.resolve("mcp_server").source, "default");
    assert.equal(registry.get("mcp_server"), false);
  });

  it("keeps the last known flags when the table stops being readable", async () => {
    // Losing contact with the table is not a reason to change a resolved value:
    // the operator's last known decision is a better answer than a guess, and the
    // guess would be "off" for a feature they deliberately turned on.
    //
    // The unreadable table is produced by aborting the transaction the registry
    // is reading through — every later statement on an aborted transaction errors,
    // which is the same shape as losing the database and needs no second
    // connection pool to arrange. The rollback at the end is what keeps the
    // fixture row out of the table the other tests read.
    await assert.rejects(
      () =>
        db.transaction(async (trx) => {
          await trx("features").insert({ key: "mcp_server", enabled: true });
          const registry = new FeatureRegistry(trx, { env: {}, logger: silent });
          await registry.refresh();
          assert.equal(registry.get("mcp_server"), true);

          await trx.raw("SELECT 1 / 0").then(
            () => assert.fail("division by zero should have aborted the transaction"),
            () => undefined,
          );

          // `refresh` rejects rather than swallowing: `setFlag` and the admin
          // route both need to know. The poller is the one caller that must never
          // propagate, and it swallows explicitly.
          await assert.rejects(() => registry.refresh());
          assert.equal(registry.get("mcp_server"), true);
          assert.equal(registry.resolve("mcp_server").source, "registry");

          throw new Error("rolling the probe row back");
        }),
      /rolling the probe row back/,
    );

    assert.equal(await db("features").where({ key: "mcp_server" }).first(), undefined);
  });
});

/* --------------------------------------------------------------------------
   Writing
   -------------------------------------------------------------------------- */

describe("setFlag", () => {
  const silent = { warn: () => {}, error: () => {} };

  function registry(env: NodeJS.ProcessEnv = {}): FeatureRegistry {
    return new FeatureRegistry(db, { env, logger: silent });
  }

  it("writes the switch and its audit row, with `enabled_from` null on the first write", async () => {
    const resolution = await registry().setFlag("mcp_server", true, operatorId, "  probing the machine channel  ");
    assert.equal(resolution.enabled, true);
    assert.equal(resolution.source, "registry");

    const row = await db("features").where({ key: "mcp_server" }).first<{
      enabled: boolean;
      updated_by: string | null;
      update_reason: string | null;
    }>("enabled", "updated_by", "update_reason");
    assert.equal(row.enabled, true);
    assert.equal(row.updated_by, operatorId);
    assert.equal(row.update_reason, "probing the machine channel");

    const audit = await db("features_audit").where({ key: "mcp_server" }).select<Array<{
      enabled_from: boolean | null;
      enabled_to: boolean;
      operator_id: string | null;
      reason: string;
      created_at: Date;
    }>>("enabled_from", "enabled_to", "operator_id", "reason", "created_at");
    assert.equal(audit.length, 1);
    // Null rather than false. Before this write there was no row, and "false"
    // would be a claim about a state that was never recorded.
    assert.equal(audit[0].enabled_from, null);
    assert.equal(audit[0].enabled_to, true);
    assert.equal(audit[0].operator_id, operatorId);
    assert.equal(audit[0].reason, "probing the machine channel");
    assert.ok(audit[0].created_at instanceof Date);
  });

  it("records the transition on a later write", async () => {
    const reg = registry();
    await reg.setFlag("mcp_server", true, operatorId, "on");
    await reg.setFlag("mcp_server", false, operatorId, "off again");

    const audit = await db("features_audit")
      .where({ key: "mcp_server" })
      .orderBy("id")
      .select<Array<{ enabled_from: boolean | null; enabled_to: boolean }>>("enabled_from", "enabled_to");
    assert.deepEqual(audit, [
      { enabled_from: null, enabled_to: true },
      { enabled_from: true, enabled_to: false },
    ]);
  });

  it("treats writing `false` where no row exists as a change, not a no-op", async () => {
    // Off-by-default and off-by-decision are different facts. This is also the
    // write that overrides a legacy variable still saying on, so refusing it
    // would leave an operator with no way to turn off a feature the deploy
    // config enables.
    const reg = registry({ EVENT_DRAIN_ENABLED: "true" });
    const resolution = await reg.setFlag("event_drain", false, operatorId, "the drain is misbehaving");

    assert.equal(resolution.enabled, false);
    assert.equal(resolution.source, "registry");
    const audit = await db("features_audit").where({ key: "event_drain" }).first<{
      enabled_from: boolean | null;
    }>("enabled_from");
    assert.equal(audit.enabled_from, null);
  });

  it("refuses a no-op, and records nothing", async () => {
    const reg = registry();
    await reg.setFlag("prerender", true, operatorId, "trying it");

    await assert.rejects(
      () => reg.setFlag("prerender", true, operatorId, "trying it harder"),
      (err: unknown) => {
        assert.ok(err instanceof FeatureRegistryError);
        assert.equal(err.statusCode, 409);
        return true;
      },
    );

    // One row, not two. The log is a list of changes, not a list of clicks.
    const audit = await db("features_audit").where({ key: "prerender" }).count<[{ count: string }]>({ count: "*" });
    assert.equal(Number(audit[0].count), 1);
  });

  it("refuses an empty or whitespace reason", async () => {
    for (const reason of ["", "   ", "\n\t"]) {
      await assert.rejects(
        () => registry().setFlag("mcp_server", true, operatorId, reason),
        (err: unknown) => {
          assert.ok(err instanceof FeatureRegistryError);
          assert.equal(err.statusCode, 400);
          return true;
        },
      );
    }
    // Refused before either table was touched, not after the switch was written.
    assert.equal(await db("features").where({ key: "mcp_server" }).first(), undefined);
  });

  it("refuses an unknown key", async () => {
    await assert.rejects(
      () => registry().setFlag("publication_wall", true, operatorId, "no"),
      (err: unknown) => {
        assert.ok(err instanceof FeatureRegistryError);
        assert.equal(err.statusCode, 404);
        return true;
      },
    );
    assert.equal(await db("features").where({ key: "publication_wall" }).first(), undefined);
  });

  it("rolls both tables back together when the audit insert fails", async () => {
    // The two rows are one act. A `features` row whose change has no audit entry
    // is an untraceable enable — the thing this design exists to remove — and an
    // audit entry with no change is a lie about what the system is doing.
    //
    // Forced by constraining `features_audit` alone, so the failure lands on the
    // second statement of the transaction with the first already applied. That is
    // the only arrangement that distinguishes "one transaction" from "two writes
    // that happen to both succeed", which is what a test that only ever sees the
    // happy path cannot tell apart.
    await db.raw(`
      ALTER TABLE features_audit
      ADD CONSTRAINT tmp_features_audit_reject_probe
      CHECK (key <> 'dated_export_archive')
    `);
    try {
      await assert.rejects(
        () => registry().setFlag("dated_export_archive", true, operatorId, "should not survive"),
        /tmp_features_audit_reject_probe/,
      );

      assert.equal(await db("features").where({ key: "dated_export_archive" }).first(), undefined);
      assert.equal(await db("features_audit").where({ key: "dated_export_archive" }).first(), undefined);
    } finally {
      await db.raw("ALTER TABLE features_audit DROP CONSTRAINT tmp_features_audit_reject_probe");
    }
  });

  it("updates the writing process's own cache on commit", async () => {
    // Before the poll, not after it. An operator whose own next page load shows
    // stale state clicks again, and on a `sends` feature a second click is not a
    // harmless one.
    const reg = registry();
    assert.equal(reg.get("mcp_server"), false);
    await reg.setFlag("mcp_server", true, operatorId, "on");
    assert.equal(reg.get("mcp_server"), true);
    assert.ok(reg.loadedAt === null, "no poll has run, so nothing has confirmed a load");
  });
});

/* --------------------------------------------------------------------------
   The call sites F1d repointed
   -------------------------------------------------------------------------- */

describe("the repointed call sites", () => {
  it("puts an installed registry's row in front of `mcpEnabled`, with no poll", async () => {
    const reg = new FeatureRegistry(db, { env: {}, logger: { warn: () => {}, error: () => {} } });
    setFeatureRegistry(reg);
    try {
      assert.equal(mcpEnabled(), false);
      await reg.setFlag("mcp_server", true, operatorId, "answering for model clients");
      // Synchronous, cached, and current in the same process that wrote it —
      // which is the whole reason the registry caches rather than querying per
      // request.
      assert.equal(mcpEnabled(), true);
    } finally {
      setFeatureRegistry(null);
    }
  });

  it("keeps `MCP_ENABLED`'s exact-string rule on the legacy step", () => {
    // `test/mcp.test.ts` pins "404s on any value other than the exact string
    // true". The registry's generic legacy reader accepts `1|yes|on` as well,
    // which every other legacy variable always did — widening it here would turn
    // a value somebody typed expecting it to be inert into a live public
    // endpoint, so `mcpEnabled` re-reads its own variable by its own rule.
    const previous = process.env.MCP_ENABLED;
    try {
      process.env.MCP_ENABLED = "1";
      assert.equal(mcpEnabled(), false);
      process.env.MCP_ENABLED = "true";
      assert.equal(mcpEnabled(), true);
    } finally {
      if (previous === undefined) delete process.env.MCP_ENABLED;
      else process.env.MCP_ENABLED = previous;
    }
  });
});

/* --------------------------------------------------------------------------
   The route
   -------------------------------------------------------------------------- */

describe("GET /api/admin/features", () => {
  it("401s without a session", async () => {
    // The guard is `requireOperator` in `routes/admin/index.ts`, and it is
    // load-bearing: PUT here is the only thing in this product that changes what
    // a stranger can read without touching Parameter Store.
    await request(app).get("/api/admin/features").expect(401);
    await request(app)
      .put("/api/admin/features/mcp_server")
      .send({ enabled: true, reason: "no session" })
      .expect(401);
  });

  it("lists every manifest entry with its resolved state and metadata", async () => {
    const res = await request(app).get("/api/admin/features").set("Cookie", cookie).expect(200);

    assert.equal(res.body.features.length, FEATURES.length);
    assert.equal(res.body.pollIntervalMs, featurePollIntervalMs());

    // The console composes its latency figure from these two, so they are served
    // rather than copied into the frontend.
    //
    // Asserted against **what a real loop instance would run on**, not against
    // the constants the route imports. A literal in this test would be the same
    // stale copy one file further along, and comparing the route's number to the
    // constant the route itself imported would pass just as happily if somebody
    // hardcoded the value here — the question is whether the console's figure
    // matches the interval the loop actually uses.
    const drainInterval = new EventDrain(db, {
      dispatcher: { dispatch: async () => assert.fail("never ticked") },
      enabled: false,
      logger: { warn: () => {}, error: () => {} },
    }).intervalMs;
    const prerenderInterval = new PrerenderConsumer(db, {
      baseUrl: "https://features-test.example",
      enabled: false,
      logger: { warn: () => {}, error: () => {} },
    }).intervalMs;

    assert.deepEqual(res.body.cycleIntervalMs, {
      event_drain: drainInterval,
      prerender: prerenderInterval,
    });
    // `mcp_server` resolves per request and has no loop of its own. Absent, not
    // zero: the console says "no loop" rather than implying instant.
    assert.equal("mcp_server" in res.body.cycleIntervalMs, false);

    const drain = res.body.features.find((f: { key: string }) => f.key === "event_drain");
    assert.ok(drain);
    assert.equal(drain.title, "Event drain");
    // `sends`, the one risk grade the console demands a typed confirmation for.
    assert.equal(drain.risk, "sends");
    assert.equal(drain.legacyEnv, "EVENT_DRAIN_ENABLED");
    assert.equal(drain.killSwitchEnv, "FEATURE_EVENT_DRAIN");
    assert.equal(drain.enabled, false);
    assert.equal(drain.source, "default");
    assert.equal(drain.lastChange, null);
    // The rebuild is on the row, not in a document — a prerequisite that lives
    // only in `docs/STATUS.md` is one that gets skipped.
    const prerender = res.body.features.find((f: { key: string }) => f.key === "prerender");
    assert.match(prerender.requiresSeed, /prerender:rebuild/);
  });

  it("reports the last change with its actor and reason", async () => {
    await request(app)
      .put("/api/admin/features/claim_publication")
      .set("Cookie", cookie)
      .send({ enabled: true, reason: "showing approved claims to readers" })
      .expect(200);

    const res = await request(app).get("/api/admin/features").set("Cookie", cookie).expect(200);
    const claim = res.body.features.find((f: { key: string }) => f.key === "claim_publication");
    assert.equal(claim.enabled, true);
    assert.equal(claim.source, "registry");
    assert.equal(claim.loadedAt !== null, true);
    assert.equal(claim.lastChange.enabledFrom, null);
    assert.equal(claim.lastChange.enabledTo, true);
    assert.equal(claim.lastChange.operatorId, operatorId);
    assert.equal(claim.lastChange.operatorEmail, OPERATOR_EMAIL);
    assert.equal(claim.lastChange.reason, "showing approved claims to readers");
  });
});

describe("PUT /api/admin/features/:key", () => {
  it("404s an unknown key", async () => {
    const res = await request(app)
      .put("/api/admin/features/publication_wall")
      .set("Cookie", cookie)
      .send({ enabled: false, reason: "there is no such switch and there must not be" })
      .expect(404);
    assert.match(res.body.error, /no such feature/);
  });

  it("400s an empty reason", async () => {
    await request(app)
      .put("/api/admin/features/mcp_server")
      .set("Cookie", cookie)
      .send({ enabled: true, reason: "   " })
      .expect(400);
    assert.equal(await db("features").where({ key: "mcp_server" }).first(), undefined);
  });

  it("400s a missing or non-boolean `enabled`", async () => {
    // Not coerced. `{ enabled: "false" }` is a truthy string, and coercing it
    // would turn a client bug into an enable.
    await request(app)
      .put("/api/admin/features/mcp_server")
      .set("Cookie", cookie)
      .send({ reason: "no value given" })
      .expect(400);
    await request(app)
      .put("/api/admin/features/mcp_server")
      .set("Cookie", cookie)
      .send({ enabled: "false", reason: "a string is not a boolean" })
      .expect(400);
  });

  it("409s a no-op", async () => {
    await request(app)
      .put("/api/admin/features/generated_narrative")
      .set("Cookie", cookie)
      .send({ enabled: true, reason: "drafting into the queue" })
      .expect(200);

    const res = await request(app)
      .put("/api/admin/features/generated_narrative")
      .set("Cookie", cookie)
      .send({ enabled: true, reason: "again" })
      .expect(409);
    assert.match(res.body.error, /already enabled/);

    const audit = await db("features_audit")
      .where({ key: "generated_narrative" })
      .count<[{ count: string }]>({ count: "*" });
    assert.equal(Number(audit[0].count), 1);
  });

  it("returns the resolution, naming the step that decided", async () => {
    const res = await request(app)
      .put("/api/admin/features/dated_export_archive")
      .set("Cookie", cookie)
      .send({ enabled: true, reason: "serving point-in-time exports" })
      .expect(200);

    assert.equal(res.body.key, "dated_export_archive");
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.source, "registry");
    assert.equal(res.body.forcedOff, false);
    assert.equal(res.body.lastChange.reason, "serving point-in-time exports");
    assert.equal(res.body.lastChange.operatorEmail, OPERATOR_EMAIL);
  });
});
