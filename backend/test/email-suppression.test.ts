import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import db from "../src/config/database";
import {
  findSuppression,
  hashAddress,
  isSuppressed,
  lift,
  normalizeAddress,
  suppress,
} from "../src/services/email-suppression";

/**
 * The list of addresses this project must not write to.
 *
 * The tests that matter are not the CRUD. They are the two ways this table
 * could quietly stop working: by storing an address in a form the send path
 * cannot look up, and by letting a suppressed address into a retry queue.
 */

const ADDRESS = "Suppression.Test@Example.Invalid";

async function clear(): Promise<void> {
  await db("email_suppressions")
    .whereIn("address_hash", [hashAddress(ADDRESS), hashAddress("other@example.invalid")])
    .del();
}

before(clear);
beforeEach(clear);

after(async () => {
  await clear();
  await db.destroy();
});

describe("email suppression", () => {
  it("stores no address in plaintext", async () => {
    await suppress(db, { address: ADDRESS, reason: "complained", source: "provider_webhook" });

    const rows = await db("email_suppressions").select("*");
    const dump = JSON.stringify(rows);
    // A suppression list is otherwise a second copy of the subscriber list, in
    // a table nobody thinks of as holding personal data — and the copy that
    // outlives every unsubscribe, because its purpose is to persist after the
    // relationship ends.
    assert.ok(!dump.includes("Suppression.Test"), "leaked the address");
    assert.ok(!dump.toLowerCase().includes("example.invalid"), "leaked the domain");
  });

  /**
   * Writer and reader must normalise identically. If they drift, every
   * suppression becomes a miss and the failure is silent — mail keeps going to
   * people who asked us to stop, and the table looks fine.
   */
  it("matches regardless of case or surrounding whitespace", async () => {
    await suppress(db, { address: ADDRESS, reason: "unsubscribed", source: "unsubscribe_link" });

    assert.ok(await isSuppressed(db, ADDRESS));
    assert.ok(await isSuppressed(db, ADDRESS.toLowerCase()));
    assert.ok(await isSuppressed(db, `  ${ADDRESS.toUpperCase()}  `));
  });

  /**
   * Gmail's dot and plus rules are Gmail's, not the internet's. Applying them
   * everywhere would merge two genuinely different mailboxes at a provider that
   * treats them as different, and suppressing mail to someone who never asked
   * is the worse error.
   */
  it("does not invent provider-specific address rules", async () => {
    await suppress(db, { address: "a.b@example.invalid", reason: "unsubscribed", source: "link" });
    assert.equal(await isSuppressed(db, "ab@example.invalid"), false);
    assert.equal(await isSuppressed(db, "a.b+tag@example.invalid"), false);
  });

  it("reports why, because the reasons are operationally different", async () => {
    await suppress(db, { address: ADDRESS, reason: "bounced_hard", source: "provider_webhook" });
    const found = await findSuppression(db, ADDRESS);
    assert.equal(found?.reason, "bounced_hard");
    assert.equal(found?.source, "provider_webhook");
  });

  /**
   * The first reason is why we stopped. A later hard bounce on an address that
   * already unsubscribed tells us nothing new about consent, and overwriting
   * would lose the fact that a person asked.
   */
  it("keeps the first reason when an address is suppressed twice", async () => {
    await suppress(db, { address: ADDRESS, reason: "unsubscribed", source: "unsubscribe_link" });
    await suppress(db, { address: ADDRESS, reason: "bounced_hard", source: "provider_webhook" });

    assert.equal((await findSuppression(db, ADDRESS))?.reason, "unsubscribed");
    const count = await db("email_suppressions")
      .where({ address_hash: hashAddress(ADDRESS) })
      .count<{ n: string }[]>({ n: "id" });
    assert.equal(Number(count[0].n), 1, "a second suppression must not add a row");
  });

  it("refuses to suppress an empty address", async () => {
    await assert.rejects(
      () => suppress(db, { address: "   ", reason: "operator_block", source: "operator" }),
      TypeError,
    );
  });

  it("refuses a plaintext address in the hash column at the database level", async () => {
    await assert.rejects(
      () =>
        db("email_suppressions").insert({
          address_hash: "someone@example.invalid",
          reason: "operator_block",
          source: "operator",
        }),
      /email_suppressions_hash_check/,
    );
  });

  /**
   * Lifting exists because a hard bounce can be a mail server having a bad
   * week, and a permanent block on a transient failure is a person who can
   * never be told their dispute was upheld.
   */
  it("can be lifted, and reports whether anything was lifted", async () => {
    await suppress(db, { address: ADDRESS, reason: "bounced_hard", source: "provider_webhook" });
    assert.equal(await lift(db, ADDRESS), true);
    assert.equal(await isSuppressed(db, ADDRESS), false);
    assert.equal(await lift(db, ADDRESS), false, "lifting nothing must say so");
  });

  it("normalises without altering the address body", async () => {
    assert.equal(normalizeAddress("  A@B.Invalid "), "a@b.invalid");
  });
});
