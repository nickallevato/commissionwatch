import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import db from "../src/config/database";
import {
  EmailDeliveryService,
  defaultAlertFromEmail,
  type ResendClient,
} from "../src/services/email-delivery";

/**
 * The From address, and the alignment it used to break by construction.
 *
 * The default was the literal `alerts@commissionwatch.org` while the site
 * deploys at `commissionwatch.bmux.sh`. Those are different organizational
 * domains, so no SPF or DKIM record for the sending domain could ever have made
 * the From header align — DMARC failed on every message before any DNS was
 * written, and a receiving server reports that by filing the mail as spam, which
 * looks exactly like a subscriber who did not open it.
 *
 * What this suite holds:
 *
 *  - **the default is derived, not declared.** It comes from `PUBLIC_BASE_URL`,
 *    the variable that already decides every canonical URL and every citation, so
 *    alignment is a property of the code rather than of two literals in different
 *    files agreeing;
 *  - **it is never on a domain we do not deploy.** The specific old value is
 *    named, because a regression to it would be silent everywhere else;
 *  - **an operator's `ALERT_FROM_EMAIL` still wins.** A derived default is a
 *    default, not a policy, and an operator who has a sending domain configured
 *    must be able to say so;
 *  - **what actually leaves the process carries it.** The derivation being right
 *    is not the same as the mailer using it.
 *
 * **This does not make mail deliverable.** SPF, DKIM and DMARC records for the
 * sending domain are an operator and DNS task and stay one; `docs/STATUS.md`
 * records them as outstanding. Nothing here creates a record, checks a record, or
 * claims one exists. What it removes is a misalignment that no record could have
 * fixed.
 */

const DEPLOYED = "commissionwatch.bmux.sh";

/** The address that could never align. Named so a regression to it fails here. */
const NEVER = "alerts@commissionwatch.org";

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  assert.ok(at > 0, `${address} is not an address`);
  return address.slice(at + 1);
}

describe("the alert From address aligns with the deployed domain", () => {
  it("derives the default from PUBLIC_BASE_URL's host", () => {
    // The property the plan asks for: with both set, they agree.
    for (const base of [
      "https://commissionwatch.bmux.sh",
      "https://commissionwatch.bmux.sh/",
      "https://example.invalid",
      "http://sub.example.invalid/some/path?q=1",
    ]) {
      const from = defaultAlertFromEmail({ PUBLIC_BASE_URL: base });
      assert.equal(
        domainOf(from),
        new URL(base).hostname,
        `${from} does not align with ${base}`,
      );
    }
  });

  it("strips a port, which is an authority and not a domain", () => {
    assert.equal(defaultAlertFromEmail({ PUBLIC_BASE_URL: "http://localhost:3000" }), "alerts@localhost");
  });

  it("lower-cases the host", () => {
    assert.equal(
      defaultAlertFromEmail({ PUBLIC_BASE_URL: "https://CommissionWatch.BMUX.sh" }),
      `alerts@${DEPLOYED}`,
    );
  });

  it("falls back to the deployed domain rather than throwing", () => {
    // Called from a constructor that runs at boot. Refusing to start over a
    // malformed variable would take the whole site down to protect a mailer that
    // sends nothing today.
    for (const env of [
      {},
      { PUBLIC_BASE_URL: "" },
      { PUBLIC_BASE_URL: "   " },
      { PUBLIC_BASE_URL: "not a url" },
    ]) {
      assert.equal(defaultAlertFromEmail(env), `alerts@${DEPLOYED}`);
    }
  });

  it("never defaults to a domain this project does not deploy", () => {
    // The specific regression. `commissionwatch.org` is not ours to send from.
    for (const env of [{}, { PUBLIC_BASE_URL: "https://commissionwatch.bmux.sh" }]) {
      assert.notEqual(defaultAlertFromEmail(env), NEVER);
      assert.notEqual(domainOf(defaultAlertFromEmail(env)), "commissionwatch.org");
    }
  });

  it("sends from the derived address", async () => {
    // The derivation being right is not the same as the mailer using it, and the
    // only place that is observable is what is handed to the provider.
    const sent: Array<{ from: string; to: string }> = [];
    const client: ResendClient = {
      emails: {
        send: async (params) => {
          sent.push({ from: params.from, to: params.to });
          return { id: "test-message-id" };
        },
      },
    };

    const previous = process.env.PUBLIC_BASE_URL;
    const previousFrom = process.env.ALERT_FROM_EMAIL;
    try {
      process.env.PUBLIC_BASE_URL = "https://alignment.example.invalid";
      delete process.env.ALERT_FROM_EMAIL;

      const service = new EmailDeliveryService(db, "test-key", undefined, client);
      const outcome = await service.sendTransactional(
        "reader@example.invalid",
        "A subject",
        "<p>A body</p>",
      );

      assert.equal(outcome.delivered, true);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].from, "alerts@alignment.example.invalid");
    } finally {
      if (previous === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = previous;
      if (previousFrom === undefined) delete process.env.ALERT_FROM_EMAIL;
      else process.env.ALERT_FROM_EMAIL = previousFrom;
    }
  });

  it("lets an operator's ALERT_FROM_EMAIL win over the derived default", async () => {
    // A derived default is a default, not a policy. An operator with a sending
    // domain already configured has to be able to say so.
    const sent: string[] = [];
    const client: ResendClient = {
      emails: {
        send: async (params) => {
          sent.push(params.from);
          return { id: "test-message-id" };
        },
      },
    };

    const previous = process.env.ALERT_FROM_EMAIL;
    const previousBase = process.env.PUBLIC_BASE_URL;
    try {
      process.env.PUBLIC_BASE_URL = "https://alignment.example.invalid";
      process.env.ALERT_FROM_EMAIL = "notices@operator.example.invalid";

      const service = new EmailDeliveryService(db, "test-key", undefined, client);
      await service.sendTransactional("reader@example.invalid", "A subject", "<p>A body</p>");
      assert.deepEqual(sent, ["notices@operator.example.invalid"]);
    } finally {
      if (previous === undefined) delete process.env.ALERT_FROM_EMAIL;
      else process.env.ALERT_FROM_EMAIL = previous;
      if (previousBase === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = previousBase;
    }
  });

  it("lets an explicit constructor argument win over both", async () => {
    const sent: string[] = [];
    const client: ResendClient = {
      emails: {
        send: async (params) => {
          sent.push(params.from);
          return { id: "test-message-id" };
        },
      },
    };

    const previous = process.env.ALERT_FROM_EMAIL;
    try {
      process.env.ALERT_FROM_EMAIL = "notices@operator.example.invalid";
      const service = new EmailDeliveryService(db, "test-key", "explicit@example.invalid", client);
      await service.sendTransactional("reader@example.invalid", "A subject", "<p>A body</p>");
      assert.deepEqual(sent, ["explicit@example.invalid"]);
    } finally {
      if (previous === undefined) delete process.env.ALERT_FROM_EMAIL;
      else process.env.ALERT_FROM_EMAIL = previous;
    }
  });
});

after(async () => {
  await db.destroy();
});
