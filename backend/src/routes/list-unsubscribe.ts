import { Router, type Response } from "express";
import db from "../config/database";
import { SubscriptionService } from "../services/delivery/subscriptions";
import { suppress } from "../services/email-suppression";

/**
 * One-click unsubscribe — RFC 8058, the `List-Unsubscribe-Post` end.
 *
 * Delivery §5c: both headers, one-click, working without a login and asking the
 * recipient to identify themselves no further than the token they were sent.
 * Gmail and Yahoo require this of bulk senders, and the requirement is the right
 * one: an unsubscribe that demands an account is an unsubscribe that does not
 * work, and the person clicking it has already told us everything we are
 * entitled to ask.
 *
 * ## Why a route of its own rather than a POST on `/api/subscriptions`
 *
 * The token addresses **two** tables. `alert_subscriptions` is the legacy row
 * `EmailDeliveryService` still sends from; `delivery_channels` is the unified
 * one B-e introduced and retains alongside it. A person who clicks unsubscribe
 * means *stop*, not *stop from whichever of your two tables I happen to be in* —
 * and while the two are back-filled onto each other, a header that unsubscribed
 * only one of them would be a consent failure the day the cutover happens. So
 * this endpoint tries both, and reports success if either matched.
 *
 * ## GET does not unsubscribe
 *
 * A mail client that does not implement one-click puts the same URL behind a
 * link, and link-prefetchers, corporate scanners and antivirus proxies fetch
 * those without a human involved. A GET that acted would unsubscribe people who
 * never clicked. So GET renders a one-button page that POSTs, and only the POST
 * acts. That page is deliberately a self-contained document with no stylesheet
 * and no script: it is opened out of a mail client, and the SPA's hashed bundle
 * name is not knowable from here — see `services/prerender/document.ts` for the
 * same reasoning.
 *
 * ## It sends nothing
 *
 * There is no confirmation email. A message saying "you have been unsubscribed"
 * is one more message to somebody who just asked for none, and it is also the
 * mechanism by which a forged unsubscribe becomes a way to mail a stranger.
 */

const router = Router();

const TOKEN_RE = /^[0-9a-f]{64}$/i;

const service = new SubscriptionService(db);

interface LegacyRow {
  id: string;
  email: string;
}

/**
 * The whole action, shared by the POST and by nothing else.
 *
 * It returns nothing, and that is the design rather than an omission: the caller
 * must answer identically whether or not the token matched, so there is no
 * outcome for it to branch on.
 */
async function unsubscribeByToken(token: string): Promise<void> {
  const rows = await db("alert_subscriptions")
    .where({ unsubscribe_token: token })
    .update({ email_enabled: false, updated_at: db.fn.now() })
    .returning<LegacyRow[]>(["id", "email"]);

  for (const row of rows) {
    // Suppression as well as the flag, because they answer different questions.
    // `email_enabled` stops the digest; the suppression list stops *every*
    // sender, including the transactional path a dispute reply takes, which has
    // no subscription row to consult. §5b puts the check at the sender for
    // exactly this reason, and this is the writer that feeds it.
    await suppress(db, {
      address: row.email,
      reason: "unsubscribed",
      source: "list-unsubscribe-one-click",
    });
  }

  // The unified channel. `unsubscribe` disables the channel and every route on
  // it and is idempotent, so a second click is a success rather than a 404 —
  // which is what a mail client retrying on a flaky network must get.
  await service.unsubscribe(token);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(res: Response, status: number, heading: string, body: string, form?: string): void {
  res
    .status(status)
    .type("text/html; charset=utf-8")
    .send(
      `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(heading)} — CommissionWatch</title>
</head>
<body style="font-family: system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5;">
<h1 style="font-size: 1.25rem;">${escapeHtml(heading)}</h1>
<p>${escapeHtml(body)}</p>
${form ?? ""}
</body>
</html>
`,
    );
}

router.get("/:token", (req, res) => {
  const { token } = req.params;
  if (!TOKEN_RE.test(token)) {
    // The same page either way. Telling a stranger that a token is well formed
    // but unknown is telling them something about who is subscribed.
    page(res, 400, "That link is not valid", "Check the link in your email and try again.");
    return;
  }

  page(
    res,
    200,
    "Unsubscribe",
    "Confirm and we will stop emailing this address. Nothing else about you is stored or needed.",
    `<form method="post" action="/api/list-unsubscribe/${escapeHtml(token)}">
<button type="submit" style="font: inherit; padding: 0.5rem 1rem;">Unsubscribe</button>
</form>`,
  );
});

/**
 * The one-click target.
 *
 * RFC 8058 sends `List-Unsubscribe=One-Click` as a form body, and this route
 * does not read it: the token in the path is the authorisation, and refusing a
 * client whose body we did not like would break the unsubscribe rather than
 * protect anything. A well-formed token that matches nothing is a **200**, not a
 * 404 — a mail provider that gets an error marks one-click as unsupported for
 * this sender, and the person who clicked would then be told nothing happened.
 */
router.post("/:token", (req, res, next) => {
  const { token } = req.params;
  if (!TOKEN_RE.test(token)) {
    res.status(400).json({ error: "Invalid unsubscribe token", statusCode: 400 });
    return;
  }

  unsubscribeByToken(token)
    .then(() => {
      // The same body whether or not the token matched. A response that differed
      // would let anyone test tokens until one came back "matched", which is a
      // slow enumeration of who is subscribed — and this is the one endpoint on
      // the site that has to answer an unauthenticated stranger.
      res.json({ message: "Unsubscribed" });
    })
    .catch(next);
});

export default router;
