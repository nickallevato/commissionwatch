import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Knex } from "knex";
import { renderDocument } from "./document";
import {
  buildDataPage,
  buildFindingPage,
  buildMeetingPage,
  buildOfficialPage,
  buildSourcePage,
  meetingIdForClaim,
  meetingSources,
} from "./pages";
import { PrerenderStore } from "./store";

/**
 * The seventh reader of the event log, and the one that writes files.
 *
 * `emitEvent` will not write an event whose subject is not public, and
 * `EventDrain` claims with `FOR UPDATE SKIP LOCKED`. That is the entire argument
 * for driving prerendering off the spine: this consumer needs no publication
 * logic of its own, and the wall it depends on is asserted by code with no other
 * job.
 *
 * Three decisions in here are not obvious, and one of them is a correction to
 * the spec.
 *
 * **The cursor is `(updated_at, id)`, not `occurred_at` and not
 * `dispatched_at`.** `dispatched_at` belongs to `EventDrain`; a second consumer
 * marking it would steal events from the dispatcher. `occurred_at` looks like
 * the right cursor and is not, because **revocation does not move it**.
 * `retractSubject` sets `revoked_at` and `updated_at` on rows that were written
 * days ago, so a consumer walking `occurred_at` would never see the withdrawal
 * at all. Walking `updated_at` sees both the publication and the revocation, in
 * that order.
 *
 * **An event is a trigger, never an instruction.** The consumer does not read
 * `event_type` and act on its meaning. It reads *which subject changed*, then
 * re-asks the publication helpers what that subject is now, and writes or
 * deletes accordingly. This matters because of a real gap in the retraction
 * path: `retractSubject` emits a `*.retracted` event **only when an earlier
 * event had already been dispatched**. With `EVENT_DRAIN_ENABLED` unset — which
 * is its default, and is how production runs today — unpublishing a meeting
 * revokes its `meeting.published` row and emits nothing. A consumer keyed on
 * `meeting.retracted` would leave the prerendered file on disk forever. That is
 * precisely the failure this feature must not have, so nothing here depends on
 * a retraction event existing.
 *
 * **Rendering is idempotent, so an overlapping replay costs nothing.** The
 * cursor bounds work; it is not a correctness mechanism. Losing the cursor file
 * means a full rebuild, which produces byte-identical pages. That is why this
 * needs no migration and no new table: a cursor whose worst failure is doing the
 * work twice does not need transactional storage.
 *
 * ## What this does not do
 *
 * The document it writes is self-contained and does not load the SPA bundle —
 * `document.ts` says why. Serving these files to a *browser* would therefore
 * replace the React app on those routes, which is a downgrade for a human
 * reader. The deployment note in the report covers the two ways out (serve the
 * prerendered tree only to crawlers, or wire hydration in the frontend); neither
 * is decided here, and nothing in this file assumes either.
 */

export type PrerenderTargetKind = "meeting" | "finding" | "official" | "source" | "data";

export interface PrerenderTarget {
  kind: PrerenderTargetKind;
  /** A uuid, a 64-hex content address, or `""` for the singleton `data` page. */
  id: string;
}

export interface PrerenderCursor {
  updated_at: string;
  id: string;
}

export interface PrerenderTickResult {
  /** Events read past the cursor. */
  scanned: number;
  /** Pages written or rewritten. */
  written: number;
  /** Pages deleted because their subject is no longer public. */
  removed: number;
  cursor: PrerenderCursor | null;
}

export interface PrerenderLogger {
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface PrerenderConsumerOptions {
  store?: PrerenderStore;
  /** Absolute origin for canonicals. Defaults to `PUBLIC_BASE_URL`. */
  baseUrl?: string;
  batchSize?: number;
  intervalMs?: number;
  enabled?: boolean;
  logger?: PrerenderLogger;
}

export const DEFAULT_PRERENDER_BATCH_SIZE = 200;
export const DEFAULT_PRERENDER_INTERVAL_MS = 10_000;

const SHA256_RE = /^[0-9a-f]{64}$/;
const CURSOR_FILE = ".prerender-cursor.json";

/** Subject kinds that name something with a page. `ops` and `dispute` never do. */
const RENDERABLE_KINDS: readonly string[] = ["meeting", "finding", "claim", "document"];

/**
 * `PRERENDER_ENABLED`, defaulting to **off**, for the reason
 * `eventDrainEnabled` gives: the loop ships and runs dark before anything serves
 * what it writes. A dark consumer writing files nobody reads still proves the
 * loop, which is the only way to find out the loop is wrong without a reader
 * finding out first.
 */
export function prerenderEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PRERENDER_ENABLED;
  if (raw === undefined || raw.trim() === "") return false;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/**
 * `PUBLIC_BASE_URL`, with no localhost fallback — `routes/sitemap.ts` gives the
 * argument and this is the same one with a worse failure mode. A relative
 * canonical under a proxy points at the wrong host; a canonical built on
 * `http://localhost:3000` points at nothing, on every page, in a file that stays
 * on disk until something rewrites it.
 */
export class PrerenderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrerenderConfigError";
  }
}

export function prerenderBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PUBLIC_BASE_URL;
  if (raw === undefined || raw.trim() === "") {
    throw new PrerenderConfigError(
      "prerender: PUBLIC_BASE_URL is not configured. Every prerendered page carries an " +
        "absolute canonical, and a canonical pointing at the wrong host is worse than no page.",
    );
  }
  return raw.trim().replace(/\/+$/, "");
}

export function targetPath(target: PrerenderTarget): string {
  switch (target.kind) {
    case "meeting":
      return `/meetings/${target.id}`;
    case "finding":
      return `/findings/${target.id}`;
    case "official":
      return `/officials/${target.id}`;
    case "source":
      return `/source/${target.id}`;
    case "data":
      return "/data";
  }
}

function targetKey(target: PrerenderTarget): string {
  return `${target.kind}:${target.id}`;
}

const consoleLogger: PrerenderLogger = {
  warn: (message) => console.warn(message),
  error: (message, error) => console.error(message, error),
};

interface EventCursorRow {
  id: string;
  subject_kind: string;
  subject_id: string | null;
  updated_at: Date | string;
}

export class PrerenderConsumer {
  readonly store: PrerenderStore;
  readonly baseUrl: string;
  readonly batchSize: number;
  readonly intervalMs: number;
  readonly enabled: boolean;

  private readonly logger: PrerenderLogger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly db: Knex,
    options: PrerenderConsumerOptions = {},
  ) {
    this.store = options.store ?? new PrerenderStore();
    this.baseUrl = options.baseUrl ?? prerenderBaseUrl();
    this.batchSize = options.batchSize ?? DEFAULT_PRERENDER_BATCH_SIZE;
    this.intervalMs = options.intervalMs ?? DEFAULT_PRERENDER_INTERVAL_MS;
    this.enabled = options.enabled ?? prerenderEnabled();
    this.logger = options.logger ?? consoleLogger;
  }

  /* ----------------------------------------------------------------------
     The cursor
     ---------------------------------------------------------------------- */

  private get cursorFile(): string {
    return join(this.store.root, CURSOR_FILE);
  }

  async readCursor(): Promise<PrerenderCursor | null> {
    let raw: string;
    try {
      raw = await readFile(this.cursorFile, "utf8");
    } catch {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return null;
      const record = parsed as Record<string, unknown>;
      if (typeof record.updated_at !== "string" || typeof record.id !== "string") return null;
      return { updated_at: record.updated_at, id: record.id };
    } catch {
      // A corrupt cursor rebuilds everything rather than stopping. The
      // expensive answer is the safe one here.
      this.logger.warn(`prerender: cursor at ${this.cursorFile} is unreadable; rebuilding from zero`);
      return null;
    }
  }

  async writeCursor(cursor: PrerenderCursor): Promise<void> {
    await mkdir(this.store.root, { recursive: true });
    await writeFile(this.cursorFile, `${JSON.stringify(cursor)}\n`, "utf8");
  }

  /* ----------------------------------------------------------------------
     Event → pages
     ---------------------------------------------------------------------- */

  /**
   * The dependency map, stated once.
   *
   * A claim has no page of its own — published-claim spec §3 — so
   * `claim.approved` and `claim.retracted` resolve to the *meeting* the claim
   * renders inside. A document resolves the same way, because its content
   * address is listed on the meeting page and served at `/source/{sha}`.
   *
   * The claim edge is looked up outside the publication wall on purpose: a
   * retracted claim is invisible to `whereClaimPublic` by definition, and it is
   * exactly the claim whose meeting page must be rebuilt.
   */
  async targetsForEvent(row: EventCursorRow): Promise<PrerenderTarget[]> {
    const subjectId = row.subject_id;
    if (subjectId === null) return [];
    switch (row.subject_kind) {
      case "meeting":
        return [{ kind: "meeting", id: subjectId }];
      case "finding":
        return [{ kind: "finding", id: subjectId }];
      case "claim": {
        const meetingId = await meetingIdForClaim(this.db, subjectId);
        return meetingId === null ? [] : [{ kind: "meeting", id: meetingId }];
      }
      case "document": {
        const document: unknown = await this.db("meeting_documents")
          .where({ id: subjectId })
          .first("meeting_id");
        const meetingId =
          typeof document === "object" && document !== null
            ? (document as { meeting_id?: unknown }).meeting_id
            : undefined;
        return typeof meetingId === "string" ? [{ kind: "meeting", id: meetingId }] : [];
      }
      default:
        return [];
    }
  }

  /**
   * Everything a meeting's publication state also decides.
   *
   * Unpublishing a meeting takes its findings out of `whereFindingPublic`, its
   * documents out of the source viewer, and — where it was their only published
   * vote — its officials out of the sitemap's rule. None of those emit an event
   * of their own, so a consumer that rebuilt only the meeting page would leave
   * live pages citing a withdrawn record. This is the graph the spec asked to be
   * stated explicitly, and it is walked in both directions: the same expansion
   * publishes them when the meeting is published.
   */
  async dependentsOfMeeting(meetingId: string): Promise<PrerenderTarget[]> {
    const targets: PrerenderTarget[] = [];

    const findings = await this.db("anomaly_flags")
      .where({ meeting_id: meetingId })
      .select<Array<{ id: string }>>("id");
    for (const finding of findings) targets.push({ kind: "finding", id: finding.id });

    // Not filtered by publication: an artifact whose meeting has just been
    // withdrawn is precisely the page that has to be deleted.
    for (const source of await meetingSources(this.db, meetingId)) {
      if (SHA256_RE.test(source.sha256)) targets.push({ kind: "source", id: source.sha256 });
    }

    const officials = await this.db("votes")
      .where({ meeting_id: meetingId })
      .distinct<Array<{ member_id: string | null }>>("member_id");
    for (const official of officials) {
      if (typeof official.member_id === "string") {
        targets.push({ kind: "official", id: official.member_id });
      }
    }

    return targets;
  }

  /* ----------------------------------------------------------------------
     Rendering
     ---------------------------------------------------------------------- */

  private async buildPage(target: PrerenderTarget) {
    switch (target.kind) {
      case "meeting":
        return buildMeetingPage(this.db, target.id, this.baseUrl);
      case "finding":
        return buildFindingPage(this.db, target.id, this.baseUrl);
      case "official":
        return buildOfficialPage(this.db, target.id, this.baseUrl);
      case "source":
        return buildSourcePage(this.db, target.id, this.baseUrl);
      case "data":
        return buildDataPage(this.baseUrl);
    }
  }

  /**
   * Writes the page, or deletes it.
   *
   * `null` from a builder means the publication helpers say this object is not
   * public *right now*, and the only correct response is that no file exists.
   * There is no third branch — no "leave it alone", no "mark it stale" — because
   * a prerendered page that outlives its withdrawal is the worst failure this
   * system can produce.
   */
  async renderTarget(target: PrerenderTarget): Promise<"written" | "removed"> {
    const path = targetPath(target);
    const page = await this.buildPage(target);
    if (page === null) {
      await this.store.remove(path);
      return "removed";
    }
    await this.store.write(path, renderDocument(page, this.baseUrl));
    return "written";
  }

  private async renderAll(targets: Iterable<PrerenderTarget>): Promise<{
    written: number;
    removed: number;
  }> {
    const seen = new Set<string>();
    let written = 0;
    let removed = 0;
    for (const target of targets) {
      const key = targetKey(target);
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        if ((await this.renderTarget(target)) === "written") written += 1;
        else removed += 1;
      } catch (error) {
        // One bad record must not stop the batch, and it must not be silent
        // either. The cursor still advances: the next publish on that subject
        // retries it, and `rebuild()` fixes it unconditionally.
        this.logger.error(`prerender: ${targetPath(target)} failed to render`, error);
      }
    }
    return { written, removed };
  }

  /* ----------------------------------------------------------------------
     The loop
     ---------------------------------------------------------------------- */

  async tick(): Promise<PrerenderTickResult> {
    const cursor = await this.readCursor();
    const query = this.db("events")
      .whereIn("subject_kind", RENDERABLE_KINDS)
      .orderBy([{ column: "updated_at", order: "asc" }, { column: "id", order: "asc" }])
      .limit(this.batchSize)
      .select<EventCursorRow[]>("id", "subject_kind", "subject_id", "updated_at");

    if (cursor !== null) {
      // Keyset over the composite the ordering uses, so an event sharing a
      // timestamp with the cursor row is not skipped.
      query.whereRaw("(events.updated_at, events.id) > (?::timestamptz, ?::uuid)", [
        cursor.updated_at,
        cursor.id,
      ]);
    }

    const rows = await query;
    if (rows.length === 0) return { scanned: 0, written: 0, removed: 0, cursor };

    const targets: PrerenderTarget[] = [];
    for (const row of rows) {
      for (const target of await this.targetsForEvent(row)) {
        targets.push(target);
        if (target.kind === "meeting") {
          targets.push(...(await this.dependentsOfMeeting(target.id)));
        }
      }
    }

    const counts = await this.renderAll(targets);

    const last = rows[rows.length - 1];
    const next: PrerenderCursor = {
      updated_at:
        last.updated_at instanceof Date ? last.updated_at.toISOString() : String(last.updated_at),
      id: last.id,
    };
    await this.writeCursor(next);

    return { scanned: rows.length, written: counts.written, removed: counts.removed, cursor: next };
  }

  /**
   * Every page, from the record rather than from the log.
   *
   * The spec's "rebuild-all is `dispatched_at = NULL` over the consumer's
   * cursor" does not apply here, because this consumer deliberately does not own
   * `dispatched_at` — that column is the drain's. Deleting the cursor file has
   * the same effect and costs nothing, and this method does the direct thing:
   * walk the published meetings and their dependents. Safe to run at any time;
   * it produces byte-identical pages for anything already correct.
   */
  async rebuild(): Promise<{ written: number; removed: number }> {
    const meetings = await this.db("meetings")
      .whereNotNull("published_at")
      .select<Array<{ id: string }>>("id");

    const targets: PrerenderTarget[] = [{ kind: "data", id: "" }];
    for (const meeting of meetings) {
      targets.push({ kind: "meeting", id: meeting.id });
      targets.push(...(await this.dependentsOfMeeting(meeting.id)));
    }
    return this.renderAll(targets);
  }

  start(): void {
    if (!this.enabled) {
      this.logger.warn(
        "prerender: disabled (PRERENDER_ENABLED is not set); no static pages will be written",
      );
      return;
    }
    if (this.timer !== null) return;

    const timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.tick()
        .catch((error: unknown) => {
          this.logger.error("prerender: tick failed", error);
        })
        .finally(() => {
          this.running = false;
        });
    }, this.intervalMs);
    timer.unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
