import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import express from "express";

process.env.CHANNEL_SECRET_KEY =
  process.env.CHANNEL_SECRET_KEY ??
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import db from "../src/config/database";
import listUnsubscribeRouter from "../src/routes/list-unsubscribe";
import {
  EmailDeliveryService,
  listUnsubscribeHeaders,
  type ResendClient,
} from "../src/services/email-delivery";
import { findSuppression, hashAddress, suppress } from "../src/services/email-suppression";

/**
 * Delivery §5c — `List-Unsubscribe`, `List-Unsubscribe-Post`, and the endpoint
 * they point at.
 *
 * These are preconditions for the first bulk send, and they are testable now
 * precisely because nothing sends: the properties worth asserting are properties
 * of what *would* leave the process, and a stand-in provider observes them
 * without a byte reaching the network.
 *
 * Four things are asserted, and each of them is a way the header set has failed
 * for other senders:
 *
 *  - **Both headers, on every list message.** One without the other is not
 *    one-click; a provider treats a lone `List-Unsubscribe` as an ordinary link
 *    and the button does not appear.
 *  - **Neither header on transactional mail.** There is no list to leave, and
 *    offering to stop the acknowledgement of somebody's own dispute is an offer
 *    to stop the reply they are waiting for.
 *  - **A suppressed address is never handed to the provider** — asserted at the
 *    sender, which is where §5b puts the check, not at a caller.
 *  - **GET does not unsubscribe.** A link-prefetcher or a corporate mail scanner
 *    fetches the URL with no human involved, and a GET that acted would
 *    unsubscribe people who never clicked.
 */

const app = express()
  .use(express.urlencoded({ extended: false }))
  .use("/api/list-unsubscribe", listUnsubscribeRouter);

const TOKEN = "b".repeat(64);
const UNKNOWN_TOKEN = "c".repeat(64);
const ADDRESS = "list-unsub-test@example.invalid";

let jurisdictionId: string;
let commissionId: string;
let meetingId: string;
let subscriptionId: string;

const SUPPRESSED_ADDRESS = "gone@example.invalid";

/** A provider that records what it was asked to send and sends nothing. */
interface Sent {
  to: string;
  subject: string;
  headers?: Record<string, string>;
}

function recorder(): { sent: Sent[]; client: ResendClient } {
  const sent: Sent[] = [];
  return {
    sent,
    client: {
      emails: {
        send: async (params) => {
          sent.push({ to: params.to, subject: params.subject, headers: params.headers });
          return { id: `stand-in-${sent.length}` };
        },
      },
    },
  };
}

before(async () => {
  await db("email_suppressions").where({ source: "list-unsubscribe-test" }).del();
  await db("alert_subscriptions").where({ email: ADDRESS }).del();

  const [jurisdiction] = await db("jurisdictions")
    .insert({ name: "list-unsub-test County", state: "MT", type: "county" })
    .returning<Array<{ id: string }>>("id");
  jurisdictionId = jurisdiction.id;

  const [commission] = await db("commissions")
    .insert({ jurisdiction_id: jurisdictionId, name: "list-unsub-test Commission" })
    .returning<Array<{ id: string }>>("id");
  commissionId = commission.id;

  const [meeting] = await db("meetings")
    .insert({
      commission_id: commissionId,
      date: "2026-08-10",
      status: "completed",
      published_at: new Date(),
    })
    .returning<Array<{ id: string }>>("id");
  meetingId = meeting.id;

  const [subscription] = await db("alert_subscriptions")
    .insert({
      email: ADDRESS,
      jurisdiction_id: jurisdictionId,
      email_enabled: true,
      verified: true,
      verify_token: "d".repeat(64),
      unsubscribe_token: TOKEN,
    })
    .returning<Array<{ id: string }>>("id");
  subscriptionId = subscription.id;
});

after(async () => {
  await db("alert_subscriptions").where({ email: ADDRESS }).del();
  // `meetings` cascades from `commissions`, which cascades from the
  // jurisdiction. The suppressions are deleted by address rather than
  // wholesale: the test database is shared, and a `del()` with no `where` on it
  // would silently un-suppress rows another suite is asserting on.
  await db("jurisdictions").where({ id: jurisdictionId }).del();
  await db("email_suppressions")
    .whereIn("address_hash", [ADDRESS, SUPPRESSED_ADDRESS].map(hashAddress))
    .del();
});

describe("the List-Unsubscribe headers", () => {
  it("carries both, and only the https URI", () => {
    const headers = listUnsubscribeHeaders("https://example.invalid/api/list-unsubscribe/abc");
    assert.equal(
      headers["List-Unsubscribe"],
      "<https://example.invalid/api/list-unsubscribe/abc>",
    );
    assert.equal(headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    // No `mailto:` alternative: it would name an inbox nobody reads, and an
    // unsubscribe address that silently discards is worse than none.
    assert.doesNotMatch(JSON.stringify(headers), /mailto/);
  });
});

describe("the sender", () => {
  it("puts both headers on a digest and points them at the one-click route", async () => {
    const { sent, client } = recorder();
    const service = new EmailDeliveryService(db, undefined, "alerts@example.invalid", client);

    const [flag] = await db("anomaly_flags")
      .insert({
        meeting_id: meetingId,
        flag_type: "missing_minutes",
        description: "A finding for the digest fixture",
        severity: "medium",
        source: "auto",
        review_state: "published",
      })
      .returning<Array<{ id: string }>>("id");
    const [notification] = await db("notifications")
      .insert({
        subscription_id: subscriptionId,
        anomaly_flag_id: flag.id,
        severity: "medium",
        email_status: "pending",
      })
      .returning<Array<{ id: string }>>("id");

    try {
      const result = await service.sendDigest([subscriptionId], ["medium"]);
      assert.deepEqual(result, { sent: 1, failed: 0, dryRun: 0 });
      // One message, and it is asserted rather than the loop being allowed to
      // pass over an empty array — the digest's join needs a published meeting
      // under the flag, and without one this test would have proved nothing.
      assert.equal(sent.length, 1);
      assert.equal(sent[0].to, ADDRESS);
      assert.equal(sent[0].headers?.["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
      assert.match(String(sent[0].headers?.["List-Unsubscribe"]), /\/api\/list-unsubscribe\//);
      assert.match(String(sent[0].headers?.["List-Unsubscribe"]), new RegExp(TOKEN));
    } finally {
      await db("notifications").where({ id: notification.id }).del();
      await db("anomaly_flags").where({ id: flag.id }).del();
    }
  });

  it("puts neither header on transactional mail", async () => {
    const { sent, client } = recorder();
    const service = new EmailDeliveryService(db, undefined, "alerts@example.invalid", client);

    const outcome = await service.sendTransactional(
      "someone-else@example.invalid",
      "Your dispute",
      "<p>We read it.</p>",
    );

    assert.equal(outcome.delivered, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].headers, undefined);
  });

  it("never hands a suppressed address to the provider", async () => {
    const { sent, client } = recorder();
    const service = new EmailDeliveryService(db, undefined, "alerts@example.invalid", client);

    await suppress(db, {
      address: SUPPRESSED_ADDRESS,
      reason: "complained",
      source: "list-unsubscribe-test",
    });

    const outcome = await service.sendTransactional(SUPPRESSED_ADDRESS, "Hello", "<p>Hi</p>");

    assert.equal(outcome.delivered, false);
    assert.ok(!outcome.delivered && outcome.reason === "suppressed");
    // The check is before the provider is even resolved: a dry-run log line
    // naming somebody who asked us to stop is still a record of us preparing to
    // contact them.
    assert.equal(sent.length, 0);
  });
});

describe("POST /api/list-unsubscribe/:token", () => {
  it("does not act on a GET, and offers a form that does", async () => {
    const res = await request(app).get(`/api/list-unsubscribe/${TOKEN}`).expect(200);
    assert.match(res.text, /<form method="post"/);
    assert.match(res.headers["content-type"], /text\/html/);

    const row = await db("alert_subscriptions").where({ id: subscriptionId }).first();
    assert.equal(row.email_enabled, true, "a GET must not unsubscribe anybody");
  });

  it("unsubscribes and suppresses on the POST", async () => {
    await request(app)
      .post(`/api/list-unsubscribe/${TOKEN}`)
      .type("form")
      .send("List-Unsubscribe=One-Click")
      .expect(200);

    const row = await db("alert_subscriptions").where({ id: subscriptionId }).first();
    assert.equal(row.email_enabled, false);

    // The flag stops the digest; the suppression stops every sender, including
    // the transactional path, which has no subscription row to consult.
    const suppression = await findSuppression(db, ADDRESS);
    assert.equal(suppression?.reason, "unsubscribed");
  });

  it("is idempotent, because a mail client retries", async () => {
    await request(app).post(`/api/list-unsubscribe/${TOKEN}`).expect(200);
    const row = await db("alert_subscriptions").where({ id: subscriptionId }).first();
    assert.equal(row.email_enabled, false);
  });

  it("answers an unknown token identically to a known one", async () => {
    const known = await request(app).post(`/api/list-unsubscribe/${TOKEN}`).expect(200);
    const unknown = await request(app).post(`/api/list-unsubscribe/${UNKNOWN_TOKEN}`).expect(200);
    // Any difference is a slow enumeration of who is subscribed.
    assert.deepEqual(unknown.body, known.body);
  });

  it("400s a malformed token", async () => {
    await request(app).post("/api/list-unsubscribe/short").expect(400);
    await request(app).get("/api/list-unsubscribe/short").expect(400);
  });
});

after(async () => {
  await db.destroy();
});
