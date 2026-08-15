import type { Knex } from "knex";
import { EXPORT_DATASETS } from "../export/datasets";
import { DATA_ATTRIBUTION, DATA_LICENSE } from "../export/manifest";
import { listPublicClaims } from "../review/claims";
import { whereFindingPublic, whereMeetingPublished } from "../publication";
import { readSourceWindow } from "../source-viewer";
import { absoluteUrl, type Block, type PageDocument } from "./document";
import { clip, type JsonObject, type JsonValue } from "./escape";

/**
 * Turning a published record into a page, and the two rules that govern every
 * builder here.
 *
 * **The publication wall is reached through `services/publication.ts`, never
 * retyped.** A prerendered page is a static file on the machine that serves the
 * public site: getting this wrong does not produce a leaked response that stops
 * when the query is fixed, it produces a file that outlives the withdrawal. So
 * every builder below returns `null` for anything the existing helpers say is
 * not public, and `null` is what makes the consumer delete rather than write.
 *
 * **Nothing here generates prose.** A `<title>` and a `<meta description>` are
 * published text, and the published-claim spec's first rule — no generated
 * sentence reaches a reader — does not stop applying because the text is in the
 * head. Every string a builder produces is either a database column, a date
 * formatted by the table below, or a count. `listPublicClaims` is reused whole
 * for the same reason: the claim sentence is a pinned template fill and this
 * file must not become a second place that renders one.
 */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * `2026-03-12` → `12 March 2026`.
 *
 * Deliberately not `toLocaleDateString`: that reads the process locale and the
 * ICU data compiled into the runtime, so the same record would title itself
 * differently on a developer's machine and in the arm64 production image. A
 * title that changes with the host is a title that churns the index.
 */
export function formatRecordDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (match === null) return iso;
  const month = MONTHS[Number(match[2]) - 1];
  if (month === undefined) return iso;
  return `${Number(match[3])} ${month} ${match[1]}`;
}

/** A `date` column, as text, whatever the driver handed back. */
function dateText(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return "";
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Plural that reads as English, because these land in a description. */
function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

export const SCHEMA_CONTEXT = "https://schema.org";

/* ---------------------------------------------------------------------------
   Meetings
   --------------------------------------------------------------------------- */

interface MeetingRow {
  id: string;
  date: string;
  time: string | null;
  location: string | null;
  status: string;
  commission_name: string;
  jurisdiction_name: string;
  jurisdiction_state: string;
}

async function loadMeeting(db: Knex, meetingId: string): Promise<MeetingRow | null> {
  const row: unknown = await whereMeetingPublished(
    db("meetings")
      .join("commissions", "commissions.id", "meetings.commission_id")
      .join("jurisdictions", "jurisdictions.id", "commissions.jurisdiction_id")
      .where("meetings.id", meetingId),
    "meetings.published_at",
  ).first(
    "meetings.id",
    db.raw("meetings.date::text as date"),
    db.raw("meetings.time::text as time"),
    "meetings.location",
    "meetings.status",
    "commissions.name as commission_name",
    "jurisdictions.name as jurisdiction_name",
    "jurisdictions.state as jurisdiction_state",
  );
  if (typeof row !== "object" || row === null) return null;
  const record = row as Record<string, unknown>;
  return {
    id: text(record.id),
    date: dateText(record.date),
    time: textOrNull(record.time),
    location: textOrNull(record.location),
    status: text(record.status),
    commission_name: text(record.commission_name),
    jurisdiction_name: text(record.jurisdiction_name),
    jurisdiction_state: text(record.jurisdiction_state),
  };
}

/** The stored documents a published meeting cites, at their content address. */
export async function meetingSources(
  db: Knex,
  meetingId: string,
): Promise<Array<{ title: string; sha256: string }>> {
  const rows = await db("meeting_documents as md")
    .join("document_versions as dv", "dv.meeting_document_id", "md.id")
    .join("artifacts as a", "a.id", "dv.artifact_id")
    .where("md.meeting_id", meetingId)
    .orderBy([{ column: "md.title", order: "asc" }, { column: "dv.version_no", order: "desc" }])
    .select<Array<Record<string, unknown>>>("md.title", "a.sha256");

  const seen = new Set<string>();
  const sources: Array<{ title: string; sha256: string }> = [];
  for (const row of rows) {
    const sha = text(row.sha256);
    if (sha === "" || seen.has(sha)) continue;
    seen.add(sha);
    sources.push({ title: text(row.title) || "Stored document", sha256: sha });
  }
  return sources;
}

/**
 * `EventCancelled` is a schema.org value and `cancelled` is a column value.
 * Mapped explicitly so a new `meeting_status` enum member fails to compile here
 * rather than silently publishing a status nobody defined.
 */
function eventStatus(status: string): string {
  switch (status) {
    case "cancelled":
      return `${SCHEMA_CONTEXT}/EventCancelled`;
    case "completed":
      return `${SCHEMA_CONTEXT}/EventScheduled`;
    default:
      return `${SCHEMA_CONTEXT}/EventScheduled`;
  }
}

/**
 * A meeting page, claims included.
 *
 * Claims are on this page and have no page of their own — the published-claim
 * spec §3 settles that, and it is the reason `claim.approved` has to re-render
 * a *meeting*. A retracted claim renders as its tombstone, from
 * `listPublicClaims`, because a reader arriving at `#claim-{id}` from a feed or
 * a Discord post must land on the sentence saying it was withdrawn rather than
 * on silence.
 */
export async function buildMeetingPage(
  db: Knex,
  meetingId: string,
  baseUrl: string,
): Promise<PageDocument | null> {
  const meeting = await loadMeeting(db, meetingId);
  if (meeting === null) return null;

  const path = `/meetings/${meeting.id}`;
  const pretty = formatRecordDate(meeting.date);
  const title = `${meeting.commission_name} — ${pretty}`;

  const items = await db("agenda_items")
    .where({ meeting_id: meeting.id })
    .orderBy("item_number", "asc")
    .select<Array<Record<string, unknown>>>("item_number", "title", "category");
  const sources = await meetingSources(db, meeting.id);
  const claims = await listPublicClaims(db, meeting.id);

  const description = clip(
    [
      `${meeting.commission_name}, ${meeting.jurisdiction_name}, ${meeting.jurisdiction_state} —`,
      `meeting record for ${pretty}.`,
      `${count(items.length, "agenda item", "agenda items")},`,
      `${count(sources.length, "source document", "source documents")},`,
      `${count(claims.claims.length, "reviewed claim", "reviewed claims")}.`,
    ].join(" "),
    300,
  );

  const event: JsonObject = {
    "@context": SCHEMA_CONTEXT,
    "@type": "Event",
    name: title,
    url: absoluteUrl(baseUrl, path),
    startDate: meeting.time === null ? meeting.date : `${meeting.date}T${meeting.time}`,
    eventStatus: eventStatus(meeting.status),
    eventAttendanceMode: `${SCHEMA_CONTEXT}/OfflineEventAttendanceMode`,
    organizer: {
      "@type": "GovernmentOrganization",
      name: meeting.commission_name,
    },
    location: {
      "@type": "Place",
      name: meeting.location ?? meeting.jurisdiction_name,
      address: {
        "@type": "PostalAddress",
        addressLocality: meeting.jurisdiction_name,
        addressRegion: meeting.jurisdiction_state,
        addressCountry: "US",
      },
    },
  };
  if (sources.length > 0) {
    event.subjectOf = sources.map(
      (source): JsonValue => ({
        "@type": "CreativeWork",
        name: source.title,
        url: absoluteUrl(baseUrl, `/source/${source.sha256}`),
      }),
    );
  }

  const blocks: Block[] = [
    {
      kind: "facts",
      items: [
        { term: "Body", value: meeting.commission_name },
        {
          term: "Jurisdiction",
          value: `${meeting.jurisdiction_name}, ${meeting.jurisdiction_state}`,
        },
        { term: "Date", value: pretty },
        ...(meeting.time === null ? [] : [{ term: "Time", value: meeting.time }]),
        ...(meeting.location === null ? [] : [{ term: "Location", value: meeting.location }]),
        { term: "Status", value: meeting.status },
      ],
    },
  ];

  blocks.push({ kind: "heading", level: 2, text: "Agenda" });
  if (items.length === 0) {
    // Absence is stated. A page that simply omits the section reads as a page
    // about a meeting with no agenda, which is a different claim.
    blocks.push({ kind: "paragraph", text: "No agenda items have been extracted for this meeting." });
  } else {
    blocks.push({
      kind: "facts",
      items: items.map((item) => ({
        term: `Item ${String(item.item_number ?? "")}`,
        value: text(item.title),
      })),
    });
  }

  blocks.push({ kind: "heading", level: 2, text: "Source documents" });
  if (sources.length === 0) {
    blocks.push({ kind: "paragraph", text: "No stored documents are attached to this meeting." });
  } else {
    blocks.push({
      kind: "links",
      items: sources.map((source) => ({
        label: `${source.title} — ${source.sha256}`,
        path: `/source/${source.sha256}`,
      })),
    });
  }

  blocks.push({ kind: "heading", level: 2, text: "Claims from the minutes" });
  if (claims.claims.length === 0 && claims.tombstones.length === 0) {
    blocks.push({
      kind: "paragraph",
      text: "No claims from this meeting have been reviewed.",
    });
  }
  for (const claim of claims.claims) {
    blocks.push({
      kind: "section",
      id: claim.anchor,
      blocks: [
        { kind: "heading", level: 3, text: claim.text },
        {
          kind: "quote",
          text: claim.quote,
          citeLabel: `Stored document ${claim.artifact_sha256}`,
          citePath: claim.source_path,
        },
      ],
    });
  }
  for (const tombstone of claims.tombstones) {
    blocks.push({
      kind: "section",
      id: tombstone.anchor,
      blocks: [
        { kind: "heading", level: 3, text: "This claim was withdrawn" },
        {
          kind: "paragraph",
          text: `Retracted ${tombstone.retracted_at.slice(0, 10)}: ${tombstone.retracted_reason}`,
        },
      ],
    });
  }
  if (claims.awaiting_re_review > 0) {
    blocks.push({
      kind: "paragraph",
      text: `${count(claims.awaiting_re_review, "claim", "claims")} from this meeting ${
        claims.awaiting_re_review === 1 ? "is" : "are"
      } awaiting re-review and ${claims.awaiting_re_review === 1 ? "is" : "are"} not shown.`,
    });
  }

  return {
    path,
    title,
    description,
    // A retracted claim is a tombstone *inside* a live record, so the meeting
    // page stays indexable. Only a page whose whole subject is a withdrawal
    // gets `noindex`.
    robots: "index",
    ogType: "article",
    jsonLd: [event],
    heading: title,
    blocks,
  };
}

/* ---------------------------------------------------------------------------
   Findings
   --------------------------------------------------------------------------- */

/**
 * The words a reader sees for a `anomaly_flag_type`, and the only ones.
 *
 * Frozen and exhaustive over the enum migrations 011, 020 and 026 define, in the
 * same shape and for the same reason as `ACTION_LABEL` in
 * `services/review/claims.ts`: an unlabelled flag type would otherwise reach a
 * reader as a raw column value, in a `<title>`, on the public internet.
 */
export const FLAG_LABEL: Readonly<Record<string, string>> = Object.freeze({
  emergency_session: "Emergency session",
  closed_door_vote: "Closed-door vote",
  last_minute_agenda_change: "Last-minute agenda change",
  quorum_issue: "Quorum issue",
  unanimous_controversial: "Unanimous vote on a contested item",
  missing_minutes: "Minutes not published",
  no_bid_contract: "No-bid contract",
  budget_spike: "Budget increase",
  fast_tracked_permit: "Fast-tracked permit",
  vote_donor_conflict: "Vote by a donation recipient",
});

export function flagLabel(flagType: string): string {
  return FLAG_LABEL[flagType] ?? "Finding";
}

/**
 * A finding page.
 *
 * The title carries the finding's own id fragment on purpose. Two findings of
 * the same type on the same meeting are legal — nothing in `anomaly_flags`
 * forbids it — so a title built only from type and meeting would collide, and a
 * set of pages sharing a title is a set of pages an index treats as one.
 */
export async function buildFindingPage(
  db: Knex,
  findingId: string,
  baseUrl: string,
): Promise<PageDocument | null> {
  const query = db("anomaly_flags")
    .leftJoin("meetings", "meetings.id", "anomaly_flags.meeting_id")
    .leftJoin("commissions", "commissions.id", "meetings.commission_id")
    .where("anomaly_flags.id", findingId)
    .select(
      "anomaly_flags.id",
      "anomaly_flags.flag_type",
      "anomaly_flags.severity",
      "anomaly_flags.description",
      "anomaly_flags.meeting_id",
      db.raw("meetings.date::text as meeting_date"),
      "commissions.name as commission_name",
    );
  const row: unknown = await whereFindingPublic(db, query).first();
  if (typeof row !== "object" || row === null) return null;
  const record = row as Record<string, unknown>;

  const id = text(record.id);
  const path = `/findings/${id}`;
  const label = flagLabel(text(record.flag_type));
  const meetingId = textOrNull(record.meeting_id);
  const meetingDate = dateText(record.meeting_date);
  const commission = textOrNull(record.commission_name);

  const context =
    commission === null || meetingDate === ""
      ? "records review"
      : `${commission}, ${formatRecordDate(meetingDate)}`;
  const title = `${label} — ${context} (${id.slice(0, 8)})`;
  const description = clip(text(record.description), 300);

  const sources =
    meetingId === null ? [] : await meetingSources(db, meetingId);

  /**
   * `ClaimReview`, not `Claim`. The reviewed thing is the record; what this
   * project publishes is its assessment of it, and saying so in the structured
   * data is the difference between "the county did X" and "we found X in the
   * county's own document". `itemReviewed` carries the citation, because a
   * finding with no source cannot be published and the machine-readable form
   * must not be the one place that omission becomes possible.
   */
  const claimReview: JsonObject = {
    "@context": SCHEMA_CONTEXT,
    "@type": "ClaimReview",
    url: absoluteUrl(baseUrl, path),
    claimReviewed: clip(text(record.description), 300),
    author: { "@type": "Organization", name: "CommissionWatch", url: absoluteUrl(baseUrl, "/") },
    itemReviewed: {
      "@type": "Claim",
      name: label,
      ...(meetingId === null
        ? {}
        : { appearance: { "@type": "CreativeWork", url: absoluteUrl(baseUrl, `/meetings/${meetingId}`) } }),
      citation: sources.map(
        (source): JsonValue => ({
          "@type": "CreativeWork",
          name: source.title,
          url: absoluteUrl(baseUrl, `/source/${source.sha256}`),
        }),
      ),
    },
  };

  const blocks: Block[] = [
    {
      kind: "facts",
      items: [
        { term: "Kind", value: label },
        { term: "Severity", value: text(record.severity) },
        ...(commission === null ? [] : [{ term: "Body", value: commission }]),
        ...(meetingDate === "" ? [] : [{ term: "Meeting date", value: formatRecordDate(meetingDate) }]),
      ],
    },
    { kind: "paragraph", text: text(record.description) },
  ];
  if (meetingId !== null) {
    blocks.push({
      kind: "links",
      items: [{ label: "The meeting record this was found in", path: `/meetings/${meetingId}` }],
    });
  }
  if (sources.length > 0) {
    blocks.push({ kind: "heading", level: 2, text: "Evidence" });
    blocks.push({
      kind: "links",
      items: sources.map((source) => ({
        label: `${source.title} — ${source.sha256}`,
        path: `/source/${source.sha256}`,
      })),
    });
  }

  return {
    path,
    title,
    description,
    robots: "index",
    ogType: "article",
    jsonLd: [claimReview],
    heading: title,
    blocks,
  };
}

/* ---------------------------------------------------------------------------
   Officials
   --------------------------------------------------------------------------- */

/**
 * An official page, and the reason `Person` is the most restrained block here.
 *
 * Structured data is *designed* to be aggregated, so the published-claim spec's
 * caution about naming a person applies harder in JSON-LD than in prose. What
 * goes in is what the public record states and nothing else: the name as the
 * roster prints it, the office, the term as recorded. No birth date, no address,
 * no email — `members.email` exists and is deliberately not read here — and no
 * image, scraped or otherwise.
 *
 * The wall is the sitemap's: a member is public when the published record
 * contains a vote of theirs. Reading `members` wholesale would put the seed
 * fixtures on the public internet, which has happened before.
 */
export async function buildOfficialPage(
  db: Knex,
  memberId: string,
  baseUrl: string,
): Promise<PageDocument | null> {
  const row: unknown = await db("members")
    .join("jurisdictions", "jurisdictions.id", "members.jurisdiction_id")
    .where("members.id", memberId)
    .whereExists(
      whereMeetingPublished(
        db("votes")
          .join("meetings", "meetings.id", "votes.meeting_id")
          .whereRaw("votes.member_id = members.id"),
        "meetings.published_at",
      ),
    )
    .first(
      "members.id",
      "members.name",
      "members.title",
      db.raw("members.term_start::text as term_start"),
      db.raw("members.term_end::text as term_end"),
      "jurisdictions.name as jurisdiction_name",
      "jurisdictions.state as jurisdiction_state",
    );
  if (typeof row !== "object" || row === null) return null;
  const record = row as Record<string, unknown>;

  const id = text(record.id);
  const path = `/officials/${id}`;
  const name = text(record.name);
  const office = textOrNull(record.title);
  const jurisdiction = `${text(record.jurisdiction_name)}, ${text(record.jurisdiction_state)}`;
  const title = office === null ? `${name} — ${jurisdiction}` : `${name}, ${office} — ${jurisdiction}`;

  const tally = await whereMeetingPublished(
    db("votes")
      .join("meetings", "meetings.id", "votes.meeting_id")
      .where("votes.member_id", id),
    "meetings.published_at",
  ).count<Array<{ count: string }>>({ count: "votes.id" });
  const votes = Number(tally[0]?.count ?? 0);

  const termStart = dateText(record.term_start);
  const termEnd = dateText(record.term_end);
  const description = clip(
    [
      `${name}${office === null ? "" : `, ${office}`}, ${jurisdiction}.`,
      `${count(votes, "recorded vote", "recorded votes")} in the published meeting record.`,
      termStart === "" ? "" : `Term from ${formatRecordDate(termStart)}${termEnd === "" ? "" : ` to ${formatRecordDate(termEnd)}`}.`,
    ]
      .filter((part) => part !== "")
      .join(" "),
    300,
  );

  const person: JsonObject = {
    "@context": SCHEMA_CONTEXT,
    "@type": "Person",
    name,
    url: absoluteUrl(baseUrl, path),
    ...(office === null ? {} : { jobTitle: office }),
    memberOf: {
      "@type": "GovernmentOrganization",
      name: jurisdiction,
    },
  };
  if (office !== null) {
    person.hasOccupation = {
      "@type": "Role",
      roleName: office,
      ...(termStart === "" ? {} : { startDate: termStart }),
      ...(termEnd === "" ? {} : { endDate: termEnd }),
    };
  }

  return {
    path,
    title,
    description,
    robots: "index",
    ogType: "article",
    jsonLd: [person],
    heading: title,
    blocks: [
      {
        kind: "facts",
        items: [
          { term: "Name, as the roster prints it", value: name },
          ...(office === null ? [] : [{ term: "Office", value: office }]),
          { term: "Jurisdiction", value: jurisdiction },
          ...(termStart === "" ? [] : [{ term: "Term start", value: formatRecordDate(termStart) }]),
          ...(termEnd === "" ? [] : [{ term: "Term end", value: formatRecordDate(termEnd) }]),
          { term: "Recorded votes", value: String(votes) },
        ],
      },
      {
        kind: "paragraph",
        text:
          "Every figure on this page is counted from votes recorded in published meeting minutes. " +
          "Nothing here is inferred.",
      },
    ],
  };
}

/* ---------------------------------------------------------------------------
   Sources
   --------------------------------------------------------------------------- */

/**
 * A stored document at its content address.
 *
 * `readSourceWindow` already carries the wall — an artifact reaches it only
 * through `document_versions → meeting_documents → meetings` and
 * `whereMeetingPublished` — so this builder adds no predicate of its own. It
 * publishes the *window*, not the whole document: the page exists so a citation
 * resolves to something a crawler can read, and dumping a full extracted PDF
 * into a static file is a different feature with a different cost.
 */
export async function buildSourcePage(
  db: Knex,
  sha256: string,
  baseUrl: string,
): Promise<PageDocument | null> {
  const window = await readSourceWindow(db, sha256, 0);
  if (window === undefined) return null;

  const path = `/source/${window.sha256}`;
  const title = `${window.source_label} — stored document ${window.sha256.slice(0, 12)}`;
  const description = clip(
    `Stored source document for ${window.source_label}. SHA-256 ${window.sha256}, ` +
      `${window.byte_size} bytes, ${window.char_count} characters of extracted text.`,
    300,
  );

  const work: JsonObject = {
    "@context": SCHEMA_CONTEXT,
    "@type": "DigitalDocument",
    name: window.source_label,
    url: absoluteUrl(baseUrl, path),
    identifier: `sha256:${window.sha256}`,
    ...(window.content_type === null ? {} : { encodingFormat: window.content_type }),
    ...(window.fetched_at === null ? {} : { dateCreated: window.fetched_at }),
  };

  return {
    path,
    title,
    description,
    robots: "index",
    ogType: "article",
    jsonLd: [work],
    heading: title,
    blocks: [
      {
        kind: "facts",
        items: [
          { term: "SHA-256", value: window.sha256 },
          { term: "Bytes", value: String(window.byte_size) },
          ...(window.source_url === null
            ? []
            : [{ term: "Where we got it", value: window.source_url }]),
          ...(window.fetched_at === null ? [] : [{ term: "Fetched", value: window.fetched_at }]),
        ],
      },
      { kind: "heading", level: 2, text: "Extracted text" },
      { kind: "quote", text: window.text },
      ...(window.truncated
        ? [
            {
              kind: "paragraph" as const,
              text: `This is the first ${window.window_end - window.window_start} characters of ${window.char_count}.`,
            },
          ]
        : []),
    ],
  };
}

/* ---------------------------------------------------------------------------
   /data — the Dataset block, moved out from behind the JavaScript wall
   --------------------------------------------------------------------------- */

/**
 * `/data`, with the `Dataset` block server-rendered.
 *
 * There has been a `Dataset` block since `DataLicensePage.tsx`, and it is
 * inside a React component — behind the same JavaScript wall as everything else,
 * so the crawlers it was written for have very likely never seen it. This is
 * the same claims, in the bytes.
 *
 * `distribution` is generated from `EXPORT_DATASETS`, which is what the routes
 * actually serve, so the block cannot advertise a file the API does not have.
 * An invented `contentUrl` is a 404 that a search engine then publishes on this
 * project's behalf.
 */
export function buildDataPage(baseUrl: string): PageDocument {
  const path = "/data";
  const distribution = EXPORT_DATASETS.flatMap((dataset): JsonValue[] => [
    {
      "@type": "DataDownload",
      name: `${dataset.name} (CSV)`,
      encodingFormat: "text/csv",
      contentUrl: absoluteUrl(baseUrl, `/api/data/${dataset.name}.csv`),
    },
    {
      "@type": "DataDownload",
      name: `${dataset.name} (JSON)`,
      encodingFormat: "application/json",
      contentUrl: absoluteUrl(baseUrl, `/api/data/${dataset.name}.json`),
    },
  ]);

  const dataset: JsonObject = {
    "@context": SCHEMA_CONTEXT,
    "@type": "Dataset",
    name: "CommissionWatch — local government meeting record",
    description:
      "Published meetings, agenda items, documents, officials, votes and reviewed findings for " +
      "the local government bodies CommissionWatch monitors, with the SHA-256 content address of " +
      "the source document each record was read out of.",
    url: absoluteUrl(baseUrl, path),
    license: DATA_LICENSE.dataset.url,
    isAccessibleForFree: true,
    creator: {
      "@type": "Organization",
      name: "CommissionWatch",
      url: absoluteUrl(baseUrl, "/"),
    },
    keywords: ["local government", "civic transparency", "public meetings", "open data", "Montana"],
    spatialCoverage: "Montana, United States",
    distribution,
  };

  return {
    path,
    title: "Bulk data and licence — CommissionWatch",
    description: clip(
      `Every published record as CSV and JSON, ${DATA_LICENSE.dataset.name}. ` +
        `${EXPORT_DATASETS.length} datasets, no key and no signup. Attribution: ${DATA_ATTRIBUTION}.`,
      300,
    ),
    robots: "index",
    ogType: "website",
    jsonLd: [dataset],
    heading: "Bulk data and licence",
    blocks: [
      {
        kind: "paragraph",
        text: `${DATA_LICENSE.dataset.name}. ${DATA_LICENSE.dataset.covers}`,
      },
      {
        kind: "links",
        items: EXPORT_DATASETS.flatMap((entry) => [
          { label: `${entry.name}.csv`, path: `/api/data/${entry.name}.csv` },
          { label: `${entry.name}.json`, path: `/api/data/${entry.name}.json` },
        ]),
      },
    ],
  };
}

/* ---------------------------------------------------------------------------
   Which claims belong to which meeting
   --------------------------------------------------------------------------- */

/**
 * The meeting a claim renders inside, whatever state the claim is in.
 *
 * Deliberately outside the publication wall. This answers "which page has to be
 * rebuilt", and the case that matters most is a claim that has just *stopped*
 * being public — `whereClaimPublic` would return nothing for it, and the meeting
 * page would keep showing a retracted sentence about a named person. The wall is
 * applied where the page is built, which is the only place it decides anything.
 */
export async function meetingIdForClaim(db: Knex, claimId: string): Promise<string | null> {
  const row: unknown = await db("minute_claims").where({ id: claimId }).first("meeting_id");
  if (typeof row !== "object" || row === null) return null;
  return textOrNull((row as Record<string, unknown>).meeting_id);
}
