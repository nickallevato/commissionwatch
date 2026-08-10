import type { RecordGap } from "./gaps";

/**
 * P7 — the letter itself.
 *
 * A pure function over a gap, a jurisdiction's records law, and a requester.
 * No database handle, no clock of its own, no I/O of any kind. That is what
 * lets the public surface and the operator console be proved to produce
 * **identical text** by string equality rather than by inspection, and it is
 * why nothing in this file can send anything even by accident.
 *
 * Two rules govern every sentence below.
 *
 * **Nothing statutory is written here.** The citation, its URL and both deadline
 * figures arrive as data from `jurisdiction_records_law`. There is no default,
 * no fallback and no "Montana generally" template. Montana's stated deadlines
 * are written for executive-branch and non-local-government agencies, and the
 * jurisdictions this project watches are local governments — so a hardcoded
 * figure would be wrong precisely where it matters. When a deadline is null the
 * sentence that would have carried it is **omitted**, not softened.
 *
 * **The letter does not allege anything.** It states what record is sought and
 * cites the statute. It never says a record is late, missing through anyone's
 * doing, withheld, refused or delayed. A request is not an accusation, and this
 * project's rule against asserting motive applies to correspondence exactly as
 * it applies to findings. `records-letter.test.ts` renders every gap kind and
 * asserts a list of accusatory terms appears in none of them.
 *
 * ## The fee paragraph carries no citation, deliberately
 *
 * Montana's fee provisions live in the same section as the deadlines and are
 * subject to the same local-government split, which nobody here has read. So
 * the letter *asks* for a waiver — a request, which needs no legal authority —
 * and asserts no entitlement to one. When a jurisdiction's fee provision is
 * verified it belongs in `jurisdiction_records_law`, not in a string literal.
 */

export interface JurisdictionRecordsLaw {
  jurisdiction_id: string;
  statute_citation: string;
  statute_url: string;
  /** Business days to acknowledge. Null means not established for this class. */
  acknowledge_days: number | null;
  /** Calendar days to respond. Null means not established for this class. */
  respond_days: number | null;
  custodian_name: string | null;
  custodian_email: string | null;
  custodian_address: string | null;
  /** `YYYY-MM-DD`. */
  verified_on: string;
  verified_by: string | null;
  notes: string | null;
}

export interface Requester {
  name: string;
  email: string;
  organization?: string | null;
  address?: string | null;
  phone?: string | null;
}

export interface LetterInput {
  gap: RecordGap;
  law: JurisdictionRecordsLaw;
  requester: Requester;
  /** `YYYY-MM-DD`. Supplied, never read from a clock, so the text is a function. */
  today: string;
}

/** How old a verification may be before the letter and the console say so. */
export const VERIFICATION_MAX_AGE_DAYS = 365;

/** `YYYY-MM-DD` for a Date, in UTC, so no local zone can shift the calendar day. */
export function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Whole days between two `YYYY-MM-DD` strings, or null if either is unparseable.
 *
 * Both are parsed as UTC midnight, so the result is a difference in calendar
 * days and never in hours that happen to straddle one.
 */
export function daysBetween(from: string, to: string): number | null {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.round((end - start) / 86_400_000);
}

/**
 * Warnings that travel with a generated letter.
 *
 * A stale verification does not block generation — the citation may well still
 * be right, and refusing on it would leave an operator with no letter and no
 * way to find out. It travels *with* the letter so the person about to send it
 * knows what has and has not been checked recently.
 */
export function lawWarnings(law: JurisdictionRecordsLaw, today: string): string[] {
  const warnings: string[] = [];

  const age = daysBetween(law.verified_on, today);
  if (age !== null && age > VERIFICATION_MAX_AGE_DAYS) {
    warnings.push(
      `The statutory text for this jurisdiction was last verified on ${law.verified_on}, ` +
        `${age} days ago. Montana's public information sections carry effective and ` +
        `termination dates, so re-read ${law.statute_url} and update verified_on before ` +
        `relying on the citation or the deadlines below.`,
    );
  }

  if (law.acknowledge_days === null && law.respond_days === null) {
    warnings.push(
      "No acknowledgement or response period is recorded for this jurisdiction, so the " +
        "letter states none. That is the correct output when the applicable subsection has " +
        "not been read — it is not a rendering fault.",
    );
  }

  if (law.custodian_name === null && law.custodian_email === null && law.custodian_address === null) {
    warnings.push(
      "No custodian is recorded for this jurisdiction. The letter is addressed generically " +
        "and you will need to find the correct recipient before sending it.",
    );
  }

  return warnings;
}

function block(lines: Array<string | null | undefined>): string {
  return lines.filter((line): line is string => typeof line === "string" && line !== "").join("\n");
}

/** The address block, or a generic one when no custodian has been recorded. */
function custodianBlock(law: JurisdictionRecordsLaw, gap: RecordGap): string {
  return block([
    law.custodian_name ?? "Public Records Custodian",
    gap.jurisdiction_name,
    law.custodian_address,
    law.custodian_email,
  ]);
}

function requesterBlock(requester: Requester): string {
  return block([
    requester.name,
    requester.organization ?? null,
    requester.address ?? null,
    requester.email,
    requester.phone ?? null,
  ]);
}

/**
 * The deadline sentence — present only when a figure exists to put in it.
 *
 * Returns an empty string when both are null. That case is the *expected* one
 * today: the local-government subsection has not been read, so the honest letter
 * cites the statute and states no period at all.
 */
function deadlineSentence(law: JurisdictionRecordsLaw): string {
  const parts: string[] = [];
  if (law.acknowledge_days !== null) {
    parts.push(
      `acknowledgement of this request within ${law.acknowledge_days} business ` +
        `day${law.acknowledge_days === 1 ? "" : "s"}`,
    );
  }
  if (law.respond_days !== null) {
    parts.push(
      `a response within ${law.respond_days} day${law.respond_days === 1 ? "" : "s"}`,
    );
  }
  if (parts.length === 0) return "";
  return `As I understand ${law.statute_citation}, it provides for ${parts.join(" and ")}.`;
}

/**
 * Render the letter.
 *
 * The output is plain text with hard line breaks and no markup: it is going to
 * be pasted into an email client by a person, and the least surprising thing a
 * copy button can hand them is exactly what they will send.
 */
export function renderLetter(input: LetterInput): string {
  const { gap, law, requester, today } = input;

  const paragraphs: string[] = [];

  paragraphs.push(today);
  paragraphs.push(custodianBlock(law, gap));
  paragraphs.push(requesterBlock(requester));
  paragraphs.push(`Subject: Public records request — ${gap.requested_record}`);
  paragraphs.push(
    law.custodian_name === null ? "To the records custodian," : `Dear ${law.custodian_name},`,
  );

  paragraphs.push(
    `Under ${law.statute_citation} (${law.statute_url}), I am requesting a copy of the ` +
      `following public record of ${gap.jurisdiction_name}:`,
  );
  paragraphs.push(`    ${gap.requested_record}`);

  if (gap.reference_url) {
    // Context, so the custodian can identify the record quickly. Stated as a
    // location, with no claim about what is or is not at the other end of it.
    paragraphs.push(`For reference, a related document is published at ${gap.reference_url}.`);
  }

  const deadline = deadlineSentence(law);
  if (deadline !== "") paragraphs.push(deadline);

  paragraphs.push(
    "I am asking that any fees for locating, reviewing or copying these records be waived " +
      "or reduced, as this request is made for the purpose of public information rather " +
      "than commercial use. If fees will apply, please tell me the estimated amount before " +
      "any cost is incurred and I will confirm before you proceed.",
  );

  paragraphs.push(
    `I would prefer to receive these records in electronic form — PDF, or the native ` +
      `electronic format in which they are maintained — by email to ${requester.email}. ` +
      `If any part of a record is exempt from disclosure, please provide the remainder and ` +
      `identify the provision you are relying on for the part not provided.`,
  );

  paragraphs.push(
    "Please contact me at the address above if any part of this request needs " +
      "clarification, and I will answer promptly.",
  );

  paragraphs.push("Thank you for your assistance.");
  paragraphs.push(requester.name);

  return paragraphs.join("\n\n");
}
