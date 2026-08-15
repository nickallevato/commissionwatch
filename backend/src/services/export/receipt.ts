import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { whereFindingPublic, whereMeetingPublished } from "../publication";
import { csvRow } from "./serialize";

/**
 * A dated snapshot of everything this site said on one day, with a manifest of
 * hashes.
 *
 * `/data` currently states that "what did this site say in March" is
 * unanswerable, and it is right. Every export here is *current*: it tells a
 * reader what we say now, and gives them no way to check whether we said
 * something different last month. For a project whose subject is other people
 * quietly revising the record, that is the wrong gap to have.
 *
 * The receipt closes it. A weekly dated set of files plus `MANIFEST.sha256`,
 * committed to a public repository, means a retraction is **visible as a diff**
 * — which is precisely the accountability this project asks of the bodies it
 * watches, applied to itself.
 *
 * ## What this module does and does not do
 *
 * It builds the bytes. It does **not** commit or push them: the publishing
 * credential is a deploy key in Parameter Store fetched by the host, and putting
 * a git push inside a service that any route could reach is how a credential
 * ends up somewhere it was never meant to be. `scripts/receipt.ts` writes the
 * files; publishing them is a deliberate operator step.
 *
 * ## The wall
 *
 * Only what was public at snapshot time, through the same helpers everything
 * else uses. A receipt is the most quotable artefact this project produces — it
 * is designed to be handed to someone as evidence — so a withheld record leaking
 * into one is worse than leaking into a page, because the page can be corrected
 * and the receipt is meant to be immutable.
 *
 * ## No personal data beyond the published record
 *
 * Official names as printed in public documents, and nothing else. No dispute
 * contacts, no subscriber addresses, no operator emails. Migration 043 deleted
 * donor addresses from this database; a snapshot that reintroduced them from a
 * join would undo that decision permanently, in a file we then ask people to
 * keep.
 */

export interface ReceiptFile {
  name: string;
  contents: string;
  sha256: string;
}

export interface Receipt {
  /** `YYYY-MM-DD`, the day the snapshot describes. */
  date: string;
  files: ReceiptFile[];
  /** `MANIFEST.sha256`, in `sha256sum` format so `sha256sum -c` verifies it. */
  manifest: string;
}

function hash(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

function toFile(name: string, contents: string): ReceiptFile {
  return { name, contents, sha256: hash(contents) };
}

function isoDay(value: Date | string | null): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

const MEETING_COLUMNS = ["id", "date", "commission", "jurisdiction", "published_at"] as const;
const FINDING_COLUMNS = ["id", "flag_type", "severity", "meeting_id", "description"] as const;
const CLAIM_COLUMNS = [
  "id",
  "meeting_id",
  "subject_name",
  "action",
  "rendered_text",
  "render_sha256",
  "artifact_sha256",
  "quote_offset",
] as const;
const SOURCE_COLUMNS = ["sha256", "source_url", "fetched_at", "content_type", "byte_size"] as const;

function csv(columns: readonly string[], rows: Array<Record<string, unknown>>): string {
  return [columns.join(","), ...rows.map((row) => csvRow(columns, row))].join("\n") + "\n";
}

export async function buildReceipt(db: Knex, now: Date = new Date()): Promise<Receipt> {
  const date = isoDay(now);

  const meetings = await whereMeetingPublished(
    db("meetings")
      .join("commissions as c", "c.id", "meetings.commission_id")
      .join("jurisdictions as j", "j.id", "c.jurisdiction_id"),
    "meetings.published_at",
  )
    .select("meetings.id", "meetings.date", "c.name as commission", "j.name as jurisdiction", "meetings.published_at")
    .orderBy("meetings.date", "desc");

  const findings = await whereFindingPublic(db, db("anomaly_flags"))
    .select("anomaly_flags.id", "anomaly_flags.flag_type", "anomaly_flags.severity", "anomaly_flags.meeting_id", "anomaly_flags.description")
    .orderBy("anomaly_flags.created_at", "desc");

  // Claims carry `rendered_text` and `render_sha256` deliberately: the pin is
  // the whole guarantee that what an operator approved is what was published,
  // and a receipt that omitted it would record the sentence without the thing
  // that makes it checkable.
  const claims = await db("minute_claims")
    .join("meetings as m", "m.id", "minute_claims.meeting_id")
    .where("minute_claims.status", "approved")
    .whereNull("minute_claims.retracted_at")
    .whereNotNull("m.published_at")
    .select(
      "minute_claims.id",
      "minute_claims.meeting_id",
      "minute_claims.subject_name",
      "minute_claims.action",
      "minute_claims.rendered_text",
      "minute_claims.render_sha256",
      "minute_claims.artifact_sha256",
      "minute_claims.quote_offset",
    )
    .orderBy("minute_claims.created_at", "asc");

  // Every artifact any published meeting rests on. This is what lets a holder of
  // the receipt fetch the same document and hash it themselves.
  const sources = await whereMeetingPublished(
    db("artifacts as a")
      .join("document_versions as dv", "dv.artifact_id", "a.id")
      .join("meeting_documents as md", "md.id", "dv.meeting_document_id")
      .join("meetings as m", "m.id", "md.meeting_id"),
    "m.published_at",
  )
    .distinct("a.sha256")
    .select("a.source_url", "a.fetched_at", "a.content_type", "a.byte_size")
    .orderBy("a.sha256", "asc");

  const files: ReceiptFile[] = [
    toFile(
      "meetings.csv",
      csv(MEETING_COLUMNS, meetings.map((row: Record<string, unknown>) => ({
        ...row,
        date: isoDay(row.date as Date | string | null),
        published_at: isoDay(row.published_at as Date | string | null),
      }))),
    ),
    toFile("findings.csv", csv(FINDING_COLUMNS, findings)),
    toFile("claims.csv", csv(CLAIM_COLUMNS, claims)),
    toFile(
      "sources.csv",
      csv(SOURCE_COLUMNS, sources.map((row: Record<string, unknown>) => ({
        ...row,
        fetched_at: isoDay(row.fetched_at as Date | string | null),
      }))),
    ),
  ];

  files.push(toFile("README.md", readme(date, files)));

  return {
    date,
    files,
    // `sha256sum` format, two spaces, so `sha256sum -c MANIFEST.sha256` works
    // without anyone writing a verifier. The manifest hashes every file except
    // itself, for the obvious reason.
    manifest: files.map((file) => `${file.sha256}  ${file.name}`).join("\n") + "\n",
  };
}

function readme(date: string, files: ReceiptFile[]): string {
  const rows = files
    .filter((file) => file.name !== "README.md")
    .map((file) => `| \`${file.name}\` | ${file.contents.split("\n").length - 2} rows |`)
    .join("\n");

  return `# CommissionWatch record receipt — ${date}

Everything this site published as of ${date}, and nothing else.

Only records that were public on that date appear here. A meeting an operator
had not published, a finding awaiting review, and a claim that had been
withdrawn are all absent — the same rule the website applies, applied to this
file set.

| File | Size |
|---|---|
${rows}

## Verifying it

\`\`\`
sha256sum -c MANIFEST.sha256
\`\`\`

\`sources.csv\` lists the SHA-256 of every stored document these records rest on,
with the URL it was fetched from. Fetch a document yourself, hash it, and compare
— that is the whole point. A citation you cannot check is decoration.

## Why this exists

Every other export this project publishes is current: it says what we say now.
This one says what we said on a date, so a later change is visible as a diff
rather than as a silent revision. We ask public bodies not to quietly amend the
record. This is us accepting the same terms.
`;
}
