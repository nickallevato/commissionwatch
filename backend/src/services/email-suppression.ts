import { createHash } from "node:crypto";
import type { Knex } from "knex";

/**
 * The list of addresses this project must not write to.
 *
 * See migration 091 for why the address is hashed and why `reason` distinguishes
 * a person's choice from a mail server's rejection. This module is the only
 * thing that computes the hash, so the normalisation cannot drift between the
 * writer and the reader — which would silently make every suppression a miss.
 */

export const SUPPRESSION_REASONS = [
  "unsubscribed",
  "bounced_hard",
  "complained",
  "operator_block",
] as const;

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export interface Suppression {
  reason: SuppressionReason;
  source: string;
  created_at: string;
}

/**
 * Lowercase and trim, and nothing else.
 *
 * Deliberately *not* clever. Gmail treats `a.b@gmail.com` and `ab@gmail.com` as
 * one mailbox and ignores everything after a `+`, and it is tempting to
 * normalise for that — but those rules are Gmail's, not the internet's, and
 * applying them everywhere would silently merge two genuinely different
 * addresses at a provider that treats them as different. Suppressing mail to
 * someone who never asked is the worse error, so the normalisation stops at what
 * the RFC actually permits us to assume.
 */
export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function hashAddress(address: string): string {
  return createHash("sha256").update(normalizeAddress(address), "utf8").digest("hex");
}

export function isSuppressionReason(value: unknown): value is SuppressionReason {
  return typeof value === "string" && (SUPPRESSION_REASONS as readonly string[]).includes(value);
}

/**
 * Is this address suppressed, and why?
 *
 * Returns the reason rather than a boolean because the caller sometimes needs
 * it: a dispute acknowledgement withheld because the person unsubscribed is a
 * different operational fact from one withheld because their server hard-bounced
 * us, and a console that showed both as "not sent" would be hiding the one an
 * operator can act on.
 */
export async function findSuppression(
  db: Knex,
  address: string,
): Promise<Suppression | undefined> {
  const row: unknown = await db("email_suppressions")
    .where({ address_hash: hashAddress(address) })
    .first("reason", "source", "created_at");
  if (typeof row !== "object" || row === null) return undefined;

  const record = row as { reason?: unknown; source?: unknown; created_at?: unknown };
  if (!isSuppressionReason(record.reason)) return undefined;

  return {
    reason: record.reason,
    source: typeof record.source === "string" ? record.source : "unknown",
    created_at:
      record.created_at instanceof Date
        ? record.created_at.toISOString()
        : String(record.created_at ?? ""),
  };
}

export async function isSuppressed(db: Knex, address: string): Promise<boolean> {
  return (await findSuppression(db, address)) !== undefined;
}

export interface SuppressInput {
  address: string;
  reason: SuppressionReason;
  source: string;
  detail?: string | null;
}

/**
 * Add an address to the list, idempotently.
 *
 * A second suppression of the same address keeps the **first** reason. The
 * first one is why we stopped; a later hard bounce on an address that already
 * unsubscribed tells us nothing new about consent, and overwriting would lose
 * the fact that a person asked. `updated_at` moves so the row still shows
 * activity.
 */
export async function suppress(db: Knex, input: SuppressInput): Promise<void> {
  const normalised = normalizeAddress(input.address);
  if (normalised === "") {
    throw new TypeError("suppress: an empty address cannot be suppressed");
  }

  await db("email_suppressions")
    .insert({
      address_hash: hashAddress(normalised),
      reason: input.reason,
      source: input.source,
      detail: input.detail ?? null,
    })
    .onConflict("address_hash")
    .merge(["updated_at"]);
}

/**
 * Remove a suppression. Operator-only, and rare by design.
 *
 * It exists because a hard bounce can be a mail server having a bad week, and a
 * permanent block on a transient failure is a person who can never be told their
 * dispute was upheld. It is not an unsubscribe reversal: a person who asked us
 * to stop has to ask us to start again themselves, and this function cannot
 * know whether they did — which is why the caller must record who lifted it and
 * why.
 */
export async function lift(db: Knex, address: string): Promise<boolean> {
  const removed = await db("email_suppressions")
    .where({ address_hash: hashAddress(address) })
    .del();
  return removed > 0;
}
