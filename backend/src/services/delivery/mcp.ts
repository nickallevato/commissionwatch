import type { Knex } from "knex";
import { findPublishedMeeting } from "../publication";
import { search, type SearchKind, type SearchResult } from "../search";
import { listPublicClaims } from "../review/claims";
import { getOfficialProfile } from "../officials";
import { readSourceWindow } from "../source-viewer";
import { collectEventEntries } from "../feeds/entries";
import { EVENT_SEVERITIES, type EventSeverity } from "../events";

/**
 * The machine channel — a read-only MCP server over the published corpus.
 *
 * Delivery §"Two channels beyond the list" (b). Sections 1–4 of that spec make
 * this record *findable*; this makes it *callable*. An assistant asked what the
 * Bozeman commission did about a rezone can answer from the record instead of
 * from a summary of a summary — and because every response here carries the
 * artifact sha256 and the source URL, **the citation survives the hop**. That is
 * the whole point of the channel and the reason each tool result is shaped
 * around its citations rather than around its prose.
 *
 * ## Three rules govern this file
 *
 * **It is a protocol adapter and nothing else.** Every tool below delegates to
 * the same service the corresponding public HTTP route calls — `search`,
 * `findPublishedMeeting`, `listPublicClaims`, `getOfficialProfile`,
 * `readSourceWindow`, `collectEventEntries`. There is no query builder in this
 * module, deliberately: a channel that carries its own copy of the publication
 * wall is a channel that will be one clause stale after the next schema change,
 * and the first thing it publishes then is a withheld claim about a named
 * person. Delivery's own spec opens with exactly that warning.
 *
 * **`ops` never reaches a consumer.** `recent_activity` reads the event spine
 * through `collectEventEntries`, which removes `subject_kind = 'ops'` on the
 * consumer side. An MCP client is a public consumer in the same sense a feed
 * reader is, and `mcp.test.ts` asserts the exclusion here rather than trusting
 * the shared helper — one test per consumer, as the spec requires.
 *
 * **It writes nothing and sends nothing.** There is no `tools` entry with a side
 * effect, no notification path, no mailer import. MCP's `prompts` and
 * `resources` capabilities are deliberately not advertised: neither adds
 * anything the tools do not already return, and a resource list is a second
 * enumeration surface that would have to be walled all over again.
 *
 * ## Transport
 *
 * Stateless Streamable HTTP: one JSON-RPC request per POST, one JSON response
 * back, no session id and no SSE stream. Everything this server does is a pure
 * read that completes in one round trip, so there is nothing for a session to
 * hold and nothing for the server to push. `routes/mcp.ts` owns the HTTP end.
 */

/* ---------------------------------------------------------------------------
   Protocol
   --------------------------------------------------------------------------- */

/**
 * Versions this server will speak, oldest first.
 *
 * `initialize` echoes the client's version when it is one of these and answers
 * with the newest otherwise, which is what the MCP lifecycle asks for: the
 * client then decides whether it can proceed. Guessing at a version we have not
 * implemented would be worse than naming one we have.
 */
export const MCP_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"] as const;

export const MCP_LATEST_PROTOCOL_VERSION =
  MCP_PROTOCOL_VERSIONS[MCP_PROTOCOL_VERSIONS.length - 1];

export const MCP_SERVER_NAME = "commissionwatch";
export const MCP_SERVER_VERSION = "1.0.0";

/**
 * Shown to the model before it calls anything.
 *
 * It states the wall and the citation contract, because an assistant that does
 * not know a result is walled will describe an absence as "nothing happened"
 * rather than as "nothing published".
 */
export const MCP_INSTRUCTIONS = [
  "CommissionWatch publishes the local-government record for Bozeman and Gallatin County, Montana.",
  "Every tool here reads only records an operator has published; an unpublished meeting, a held or",
  "rejected finding, and a retracted claim are absent and are not distinguishable from a record that",
  "does not exist. Every result carries the sha256 of the stored document it came from and the URL it",
  "was fetched from. Quote the citation with the claim: an assertion from this server without its",
  "source is an unsourced claim, and this project exists to object to those.",
].join(" ");

export type JsonRpcId = string | number | null;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: JsonRpcError };

export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

/* ---------------------------------------------------------------------------
   Tools
   --------------------------------------------------------------------------- */

/** A citation, in the shape every tool result carries it. */
export interface McpCitation {
  /** What the caller is told they are looking at. Never generated prose. */
  label: string;
  /** Absolute. The on-site record, or the upstream document we fetched. */
  url: string;
  /** The content address of the stored bytes, when there are stored bytes. */
  sha256: string | null;
}

interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;

/**
 * Ceilings, not defaults.
 *
 * A public endpoint that accepts arbitrary query text is a public endpoint
 * somebody will use as a load generator — §2 of the delivery spec says so about
 * the query feed and it is no less true of a tool call. The same numbers as the
 * feed, for the same reason.
 */
export const MCP_MAX_RESULTS = 50;
export const MCP_MAX_QUERY_CHARS = 200;

const SEARCH_KINDS: readonly SearchKind[] = [
  "agenda_item",
  "meeting",
  "member",
  "document",
  "finding",
  "matter",
];

export const MCP_TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "search_record",
    title: "Search the published record",
    description:
      "Full-text search over published meetings, agenda items, documents, officials, findings and " +
      "matters. Supports quoted phrases and -exclusions. Returns the matching sentence, never the " +
      "whole document.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Search terms.", maxLength: MCP_MAX_QUERY_CHARS },
        kind: {
          type: "string",
          enum: [...SEARCH_KINDS],
          description: "Restrict to one kind of record.",
        },
        limit: { type: "integer", minimum: 1, maximum: MCP_MAX_RESULTS },
      },
      required: ["q"],
      additionalProperties: false,
    },
  },
  {
    name: "get_meeting",
    title: "Get a published meeting",
    description:
      "One meeting with its agenda items and its stored documents. Each document carries the sha256 " +
      "of the bytes we fetched and the URL we fetched them from.",
    inputSchema: {
      type: "object",
      properties: { meeting_id: { type: "string", description: "Meeting uuid." } },
      required: ["meeting_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_meeting_claims",
    title: "Get what the minutes record people doing at a meeting",
    description:
      "Approved, unretracted claims from one meeting's minutes, each with the quote it was drawn " +
      "from and the sha256 of the document holding that quote. Retracted claims are returned as " +
      "tombstones so a withdrawal is visible rather than silent.",
    inputSchema: {
      type: "object",
      properties: { meeting_id: { type: "string", description: "Meeting uuid." } },
      required: ["meeting_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_official_votes",
    title: "Get an official's voting record",
    description:
      "One official's tallied votes, attendance and per-meeting timeline, counted over published " +
      "meetings only, plus the findings about them that an operator has published.",
    inputSchema: {
      type: "object",
      properties: { official_id: { type: "string", description: "Member uuid." } },
      required: ["official_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_source",
    title: "Read the document behind a citation",
    description:
      "A window of the extracted text of a stored document, addressed by its sha256. This is the " +
      "other end of every citation: it is how a caller checks that a quote says what it is said to " +
      "say.",
    inputSchema: {
      type: "object",
      properties: {
        sha256: { type: "string", description: "Content address of the stored document." },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Character offset to centre the window on. Clamped, never an error.",
        },
      },
      required: ["sha256"],
      additionalProperties: false,
    },
  },
  {
    name: "recent_activity",
    title: "What was published recently",
    description:
      "The announcement stream: meetings, findings, claims and documents as they were published, " +
      "newest first, including withdrawals. The same events the public feed carries.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: MCP_MAX_RESULTS },
        jurisdiction_id: { type: "string" },
        event_type: { type: "string", description: "Exact event type, e.g. meeting.published." },
        min_severity: { type: "string", enum: [...EVENT_SEVERITIES] },
      },
      additionalProperties: false,
    },
  },
]);

/* ---------------------------------------------------------------------------
   Tool execution
   --------------------------------------------------------------------------- */

/**
 * A tool outcome.
 *
 * `isError` rather than a JSON-RPC error, because MCP draws the line there for a
 * reason a transparency project should care about: a protocol error is something
 * the client got wrong, and "that meeting is not published" is an answer. The
 * model needs to see the second one and reason about it, not have it swallowed
 * by the transport.
 */
export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

class ToolInputError extends Error {}

function toolText(payload: Record<string, unknown>): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/**
 * A refusal a model should read and act on.
 *
 * The wording never distinguishes "no such record" from "withheld", for the same
 * reason `findPublishedMeeting` does not: telling a caller which of the two it
 * is turns the withheld set into something anyone can enumerate one id at a time.
 */
function toolRefusal(message: string): McpToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolInputError(`"${key}" is required and must be a non-empty string`);
  }
  return value.trim();
}

function optionalLimit(args: Record<string, unknown>, fallback: number): number {
  const value = args.limit;
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ToolInputError('"limit" must be a positive integer');
  }
  return Math.min(value, MCP_MAX_RESULTS);
}

function optionalString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolInputError(`"${key}" must be a non-empty string when given`);
  }
  return value.trim();
}

function isSearchKind(value: string): value is SearchKind {
  return (SEARCH_KINDS as readonly string[]).includes(value);
}

/**
 * The spine's own list, imported rather than retyped.
 *
 * A second copy of a constant is the failure this project keeps finding in its
 * own code — `emitEvent` kept its own copy of the claim wall and went a clause
 * stale, and `test/adapters/contract.ts` held a hand-copied `DOCUMENT_KINDS`
 * that called every valid transcript ref unknown. A severity the spine adds and
 * this file has never heard of would simply be un-askable here, silently.
 */
function isSeverity(value: string): value is EventSeverity {
  return (EVENT_SEVERITIES as readonly string[]).includes(value);
}

/** Absolute, always. A relative citation does not survive the hop. */
function absolute(baseUrl: string, path: string): string {
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

async function searchRecord(
  db: Knex,
  baseUrl: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const q = requireString(args, "q");
  if (q.length > MCP_MAX_QUERY_CHARS) {
    throw new ToolInputError(`"q" must be at most ${MCP_MAX_QUERY_CHARS} characters`);
  }
  const kindArg = optionalString(args, "kind");
  if (kindArg !== null && !isSearchKind(kindArg)) {
    throw new ToolInputError(`"${kindArg}" is not a kind of record`);
  }
  const limit = optionalLimit(args, 20);

  // The same search the public page runs, wall and all. Filtering by kind after
  // the fact rather than pushing a predicate into `search` is deliberate: this
  // module does not get to change what that query means.
  const found = await search(db, { q, limit: MCP_MAX_RESULTS });
  const data = (kindArg === null
    ? found.data
    : found.data.filter((row) => row.kind === kindArg)
  ).slice(0, limit);

  return toolText({
    query: q,
    total: data.length,
    results: data.map((row) => ({
      ...row,
      url: absolute(baseUrl, resultPath(row)),
    })),
  });
}

/**
 * Where a search result lives on the site.
 *
 * A claim is never its own page and neither is a finding: a finding on a meeting
 * is rendered inside that meeting's record, because a page whose entire content
 * is one allegation about one named person is an accusation and the same
 * sentence inside the record it came from is a record.
 */
function resultPath(row: SearchResult): string {
  switch (row.kind) {
    case "member":
      return `/officials/${row.id}`;
    case "matter":
      return `/matters/${row.id}`;
    case "meeting":
      return `/meetings/${row.meeting_id}`;
    case "finding":
      return row.meeting_id === null ? "/findings" : `/meetings/${row.meeting_id}`;
    default:
      return `/meetings/${row.meeting_id}`;
  }
}

interface DocumentRow {
  id: string;
  title: string | null;
  document_type: string | null;
  url: string | null;
  sha256: string | null;
  source_url: string | null;
  fetched_at: Date | string | null;
}

async function getMeeting(
  db: Knex,
  baseUrl: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const meetingId = requireString(args, "meeting_id");
  if (!UUID_RE.test(meetingId)) throw new ToolInputError('"meeting_id" is not a uuid');

  const meeting = await findPublishedMeeting(db, meetingId);
  if (!meeting) return toolRefusal("No published meeting with that id.");

  const commission = await db("commissions as c")
    .join("jurisdictions as j", "j.id", "c.jurisdiction_id")
    .where("c.id", meeting.commission_id as string)
    .first<{ commission: string; jurisdiction: string; state: string } | undefined>(
      "c.name as commission",
      "j.name as jurisdiction",
      "j.state as state",
    );

  const agendaItems = await db("agenda_items")
    .where({ meeting_id: meetingId })
    .orderBy("item_number", "asc")
    .select<Array<{ item_number: number; title: string | null; description: string | null }>>(
      "item_number",
      "title",
      "description",
    );

  // The document's stored bytes, through `document_versions` — the join that
  // makes a citation checkable. A document we never successfully fetched has a
  // null sha, and says so rather than being dropped: "we know of this document
  // and do not hold it" is a fact a caller is entitled to.
  const documents = await db("meeting_documents as md")
    .leftJoin("document_versions as dv", "dv.meeting_document_id", "md.id")
    .leftJoin("artifacts as a", "a.id", "dv.artifact_id")
    .where("md.meeting_id", meetingId)
    .orderBy([{ column: "md.created_at", order: "desc" }, { column: "dv.version_no", order: "desc" }])
    .select<DocumentRow[]>(
      "md.id as id",
      "md.title as title",
      "md.document_type as document_type",
      "md.url as url",
      "a.sha256 as sha256",
      "a.source_url as source_url",
      "a.fetched_at as fetched_at",
    );

  const seen = new Set<string>();
  const latest = documents.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });

  const citations: McpCitation[] = latest.map((row) => ({
    label: row.title ?? row.document_type ?? "document",
    url: row.source_url ?? row.url ?? absolute(baseUrl, `/meetings/${meetingId}`),
    sha256: row.sha256,
  }));

  return toolText({
    meeting: {
      id: meetingId,
      date: meeting.date,
      time: meeting.time ?? null,
      status: meeting.status,
      location: meeting.location ?? null,
      commission: commission?.commission ?? null,
      jurisdiction: commission?.jurisdiction ?? null,
      state: commission?.state ?? null,
      url: absolute(baseUrl, `/meetings/${meetingId}`),
    },
    agenda_items: agendaItems,
    documents: latest.map((row) => ({
      title: row.title,
      document_type: row.document_type,
      url: row.url,
      sha256: row.sha256,
      fetched_from: row.source_url,
      fetched_at: row.fetched_at,
      // The other end of the citation, callable with `get_source`.
      read_with: row.sha256 === null ? null : { tool: "get_source", sha256: row.sha256 },
    })),
    citations,
  });
}

async function getMeetingClaims(
  db: Knex,
  baseUrl: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const meetingId = requireString(args, "meeting_id");
  if (!UUID_RE.test(meetingId)) throw new ToolInputError('"meeting_id" is not a uuid');

  // The meeting is checked first even though `listPublicClaims` is walled too.
  // Without it an unpublished meeting answers with an empty list, which tells a
  // caller the id is real.
  const meeting = await findPublishedMeeting(db, meetingId);
  if (!meeting) return toolRefusal("No published meeting with that id.");

  const claims = await listPublicClaims(db, meetingId);

  return toolText({
    meeting_url: absolute(baseUrl, `/meetings/${meetingId}`),
    claims: claims.claims.map((claim) => ({
      id: claim.id,
      text: claim.text,
      quote: claim.quote,
      artifact_sha256: claim.artifact_sha256,
      quote_offset: claim.quote_offset,
      // A claim is not a page. The anchor is inside the record it came from.
      url: absolute(baseUrl, `/meetings/${meetingId}#${claim.anchor}`),
      source_url: absolute(baseUrl, claim.source_path),
      approved_at: claim.approved_at,
    })),
    // Withdrawals travel with the claims. A response that showed only what
    // currently renders would drop the correction and keep the mistake.
    tombstones: claims.tombstones,
    awaiting_re_review: claims.awaiting_re_review,
    citations: claims.claims.map((claim) => ({
      label: claim.quote,
      url: absolute(baseUrl, claim.source_path),
      sha256: claim.artifact_sha256,
    })),
  });
}

async function getOfficialVotes(
  db: Knex,
  baseUrl: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const officialId = requireString(args, "official_id");
  if (!UUID_RE.test(officialId)) throw new ToolInputError('"official_id" is not a uuid');

  const profile = await getOfficialProfile(db, officialId);
  if (profile === null) return toolRefusal("No such official.");

  return toolText({
    official: profile.official,
    url: absolute(baseUrl, `/officials/${officialId}`),
    record: profile.record,
    attendance: profile.attendance,
    alignment: profile.alignment,
    timeline: profile.timeline.map((entry) => ({
      ...entry,
      url: absolute(baseUrl, `/meetings/${entry.meeting_id}`),
    })),
    findings: profile.findings,
    // Stated, not implied. Every figure above is counted over published meetings
    // only, and an assistant that reports "voted yes 4 times" without that
    // qualifier is reporting our coverage as though it were the record.
    counted_over: "published meetings only",
    citations: profile.timeline.map((entry) => ({
      label: `${entry.commission_name}, ${entry.date}`,
      url: absolute(baseUrl, `/meetings/${entry.meeting_id}`),
      sha256: null,
    })),
  });
}

async function getSource(
  db: Knex,
  baseUrl: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const sha256 = requireString(args, "sha256").toLowerCase();
  if (!SHA256_RE.test(sha256)) throw new ToolInputError('"sha256" is not a sha-256 hex digest');

  const offsetArg = args.offset;
  if (
    offsetArg !== undefined &&
    (typeof offsetArg !== "number" || !Number.isInteger(offsetArg) || offsetArg < 0)
  ) {
    throw new ToolInputError('"offset" must be a non-negative integer');
  }

  const window = await readSourceWindow(db, sha256, typeof offsetArg === "number" ? offsetArg : 0);
  if (window === undefined) {
    return toolRefusal("No stored document with that content address on a published meeting.");
  }

  return toolText({
    ...window,
    url: absolute(baseUrl, `/source/${sha256}`),
    citations: [
      { label: window.source_label, url: window.source_url ?? absolute(baseUrl, `/source/${sha256}`), sha256 },
    ],
  });
}

async function recentActivity(
  db: Knex,
  baseUrl: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const limit = optionalLimit(args, 20);
  const jurisdictionId = optionalString(args, "jurisdiction_id");
  if (jurisdictionId !== null && !UUID_RE.test(jurisdictionId)) {
    throw new ToolInputError('"jurisdiction_id" is not a uuid');
  }
  const minSeverity = optionalString(args, "min_severity");
  if (minSeverity !== null && !isSeverity(minSeverity)) {
    throw new ToolInputError(`"${minSeverity}" is not a severity`);
  }

  // `collectEventEntries` is the feed's collector, unchanged. It removes
  // `subject_kind = 'ops'` and every revoked row, which is exactly the filter
  // this channel would otherwise have had to re-type — and the re-typing is what
  // the delivery spec warns leaks a withheld claim.
  const entries = await collectEventEntries(db, baseUrl, {
    jurisdiction_id: jurisdictionId,
    event_type: optionalString(args, "event_type"),
    min_severity: minSeverity,
    limit,
  });

  return toolText({
    total: entries.length,
    events: entries.map((entry) => ({
      urn: entry.urn,
      title: entry.title,
      summary: entry.summary,
      url: entry.url,
      occurred_at: entry.updated.toISOString(),
      // A withdrawal is an entry of its own, never a silent deletion.
      retraction: entry.retraction,
      citation: entry.citation,
    })),
  });
}

type ToolHandler = (
  db: Knex,
  baseUrl: string,
  args: Record<string, unknown>,
) => Promise<McpToolResult>;

const HANDLERS: Readonly<Record<string, ToolHandler>> = Object.freeze({
  search_record: searchRecord,
  get_meeting: getMeeting,
  get_meeting_claims: getMeetingClaims,
  get_official_votes: getOfficialVotes,
  get_source: getSource,
  recent_activity: recentActivity,
});

/** Every advertised tool has a handler, and every handler is advertised. */
export function toolsAreConsistent(): boolean {
  const advertised = MCP_TOOLS.map((tool) => tool.name).sort();
  const implemented = Object.keys(HANDLERS).sort();
  return (
    advertised.length === implemented.length &&
    advertised.every((name, index) => name === implemented[index])
  );
}

/* ---------------------------------------------------------------------------
   Dispatch
   --------------------------------------------------------------------------- */

function negotiateVersion(params: unknown): string {
  if (isRecord(params) && typeof params.protocolVersion === "string") {
    const asked = params.protocolVersion;
    if ((MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked)) return asked;
  }
  return MCP_LATEST_PROTOCOL_VERSION;
}

/**
 * Handle one JSON-RPC message.
 *
 * Returns `null` for a notification — a message with no `id`, which under
 * JSON-RPC gets no response at all. `notifications/initialized` is the one every
 * client sends and answering it with a body is how a strict client decides the
 * server is broken.
 */
export async function handleMcpMessage(
  db: Knex,
  baseUrl: string,
  message: unknown,
): Promise<JsonRpcResponse | null> {
  if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return fail(null, JSON_RPC_INVALID_REQUEST, "Not a JSON-RPC 2.0 request");
  }

  const rawId = message.id;
  const isNotification = rawId === undefined;
  const id: JsonRpcId =
    typeof rawId === "string" || typeof rawId === "number" ? rawId : null;
  const method = message.method;
  const params = message.params;

  if (isNotification) {
    // Nothing here has state to change, so every notification is accepted and
    // dropped. Saying so explicitly beats letting it fall through to
    // "method not found", which would be a response to a message that must not
    // get one.
    return null;
  }

  try {
    switch (method) {
      case "initialize":
        return ok(id, {
          protocolVersion: negotiateVersion(params),
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: MCP_SERVER_NAME,
            title: "CommissionWatch",
            version: MCP_SERVER_VERSION,
          },
          instructions: MCP_INSTRUCTIONS,
        });

      case "ping":
        return ok(id, {});

      case "tools/list":
        return ok(id, { tools: MCP_TOOLS });

      case "tools/call": {
        if (!isRecord(params) || typeof params.name !== "string") {
          return fail(id, JSON_RPC_INVALID_PARAMS, "A tool name is required");
        }
        const handler = HANDLERS[params.name];
        if (handler === undefined) {
          return fail(id, JSON_RPC_INVALID_PARAMS, `No tool named "${params.name}"`);
        }
        const args = isRecord(params.arguments) ? params.arguments : {};
        try {
          return ok(id, await handler(db, baseUrl, args));
        } catch (err) {
          if (err instanceof ToolInputError) {
            return fail(id, JSON_RPC_INVALID_PARAMS, err.message);
          }
          throw err;
        }
      }

      default:
        return fail(id, JSON_RPC_METHOD_NOT_FOUND, `Unknown method "${method}"`);
    }
  } catch (err) {
    // The message never carries the exception text. A driver error routinely
    // quotes the SQL, and the SQL here quotes ids of records an operator has
    // withheld — the same reasoning `/status` applies to `ingestion_runs.error`.
    console.error(`MCP: ${method} failed`, err);
    return fail(id, JSON_RPC_INTERNAL_ERROR, "The server could not complete that request");
  }
}

/**
 * The discovery document at `/.well-known/mcp.json`.
 *
 * Enough for a client to find the endpoint and know what it is before opening a
 * connection, and nothing that has to be kept in step by hand: the tool list is
 * the same constant `tools/list` answers from.
 */
export function mcpDiscoveryDocument(baseUrl: string): Record<string, unknown> {
  return {
    name: MCP_SERVER_NAME,
    title: "CommissionWatch",
    version: MCP_SERVER_VERSION,
    description:
      "A read-only MCP server over the published local-government record for Bozeman and Gallatin " +
      "County, Montana. Every response carries the sha256 of the document it came from.",
    protocolVersions: [...MCP_PROTOCOL_VERSIONS],
    transport: "streamable-http",
    endpoint: absolute(baseUrl, "/mcp"),
    documentation: absolute(baseUrl, "/methodology"),
    authentication: "none",
    tools: MCP_TOOLS.map((tool) => ({ name: tool.name, title: tool.title })),
  };
}
