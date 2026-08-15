import { http, HttpResponse } from "msw";
import {
  meetings,
  jurisdictions,
  commissions,
  agendaItems,
  meetingDocuments,
  members,
  votes,
  anomalyFlags,
  matters,
  matterAppearances,
  metrics,
} from "./data";

/** Newest first — matches `.orderBy("created_at", "desc")` on /votes and /anomalies. */
function byCreatedAtDesc<T extends { created_at: string }>(a: T, b: T): number {
  return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
}

/** Oldest first — the /meetings/:id/{votes,anomalies,documents} sub-resources
 *  use the knex default direction, `.orderBy("created_at")`, i.e. ascending. */
function byCreatedAtAsc<T extends { created_at: string }>(a: T, b: T): number {
  return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
}

/** Alphabetical — /jurisdictions and /members both `.orderBy("name")`. */
function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name);
}

/**
 * Every collection route in backend/src/routes answers with `{ data, total }`.
 * Not one of them returns a bare array, so neither does any handler here.
 */
function list<T>(data: T[]) {
  return HttpResponse.json({ data, total: data.length });
}

export const handlers = [
  /**
   * The session probe `AuthProvider` fires on mount. Signed out is the default
   * for every test that is not specifically about the operator console, and it
   * is what the real API answers with no cookie. Tests that need a signed-in
   * operator override this with `server.use`.
   */
  http.get("/api/admin/session", () =>
    HttpResponse.json(
      { error: "Authentication required", statusCode: 401 },
      { status: 401 },
    ),
  ),

  /**
   * The masthead's sweep age. Null by default — the honest answer for a
   * database nobody has swept, and the state every test that is not about the
   * sweep line should see rather than an invented timestamp.
   */
  http.get("/api/ingestion/status", () =>
    HttpResponse.json({ lastSuccessfulSweepAt: null }),
  ),

  /**
   * The public status page's read. Empty by default, for the same reason as
   * the sweep line above: an empty registry is the honest state of the
   * database this project actually runs, and `StatusPage.test.tsx` installs
   * its own handler when it wants sources.
   */
  http.get("/api/ingestion/sources", () =>
    HttpResponse.json({
      generated_at: new Date().toISOString(),
      last_successful_sweep_at: null,
      total: 0,
      sources: [],
    }),
  ),

  http.get("/api/meetings", ({ request }) => {
    const url = new URL(request.url);
    const jurisdictionId = url.searchParams.get("jurisdiction_id");
    const status = url.searchParams.get("status");
    const dateFrom = url.searchParams.get("date_from");
    const dateTo = url.searchParams.get("date_to");

    let filtered = [...meetings];

    if (jurisdictionId) {
      filtered = filtered.filter(
        (m) => m.commission?.jurisdiction?.id === jurisdictionId,
      );
    }
    if (status) {
      filtered = filtered.filter((m) => m.status === status);
    }
    if (dateFrom) {
      filtered = filtered.filter((m) => m.date >= dateFrom);
    }
    if (dateTo) {
      filtered = filtered.filter((m) => m.date <= dateTo);
    }

    filtered.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );

    return list(filtered);
  }),

  // `GET /meetings/:id` spreads the row together with its agenda and documents.
  http.get("/api/meetings/:id", ({ params }) => {
    const meeting = meetings.find((m) => m.id === params.id);
    if (!meeting) return new HttpResponse(null, { status: 404 });
    return HttpResponse.json({
      ...meeting,
      agenda_items: agendaItems
        .filter((a) => a.meeting_id === params.id)
        .sort((a, b) => a.item_number - b.item_number),
      documents: meetingDocuments
        .filter((d) => d.meeting_id === params.id)
        .sort(byCreatedAtAsc),
    });
  }),

  http.get("/api/meetings/:id/agenda-items", ({ params }) => {
    const items = agendaItems
      .filter((a) => a.meeting_id === params.id)
      .sort((a, b) => a.item_number - b.item_number);
    return list(items);
  }),

  // Newest first: `/documents` is `.orderBy("created_at", "desc")`, unlike the
  // `documents` array embedded in `GET /meetings/:id`, which is ascending.
  http.get("/api/meetings/:id/documents", ({ params }) => {
    const docs = meetingDocuments
      .filter((d) => d.meeting_id === params.id)
      .sort(byCreatedAtDesc);
    return list(docs);
  }),

  http.get("/api/metrics", () => HttpResponse.json(metrics)),

  http.get("/api/matters", ({ request }) => {
    const state = new URL(request.url).searchParams.get("state");
    return list(state ? matters.filter((m) => m.state === state) : matters);
  }),

  http.get("/api/matters/:id", ({ params }) => {
    const matter = matters.find((m) => m.id === params.id);
    if (!matter) return new HttpResponse(null, { status: 404 });
    return HttpResponse.json({
      ...matter,
      appearances: matterAppearances[matter.id] ?? [],
    });
  }),

  http.get("/api/meetings/:id/votes", ({ params }) => {
    return list(
      votes.filter((v) => v.meeting_id === params.id).sort(byCreatedAtAsc),
    );
  }),

  http.get("/api/meetings/:id/anomalies", ({ params }) => {
    return list(
      anomalyFlags
        .filter((a) => a.meeting_id === params.id)
        .sort(byCreatedAtAsc),
    );
  }),

  http.get("/api/jurisdictions", () => {
    // The route is `.orderBy("jurisdictions.name")`, not insertion order, and
    // it embeds each jurisdiction's commissions.
    const data = [...jurisdictions].sort(byName).map((j) => ({
      ...j,
      commissions: commissions
        .filter((c) => c.jurisdiction_id === j.id)
        .sort(byName),
    }));
    return list(data);
  }),

  http.get("/api/members", ({ request }) => {
    const url = new URL(request.url);
    const jurisdictionId = url.searchParams.get("jurisdiction_id");

    let filtered = [...members];
    if (jurisdictionId) {
      filtered = filtered.filter((m) => m.jurisdiction_id === jurisdictionId);
    }

    // The route is `.orderBy("name", "asc")`, not insertion order.
    filtered.sort(byName);

    return list(filtered);
  }),

  http.get("/api/members/:id", ({ params }) => {
    const member = members.find((m) => m.id === params.id);
    if (!member) return new HttpResponse(null, { status: 404 });
    return HttpResponse.json(member);
  }),

  http.get("/api/votes", ({ request }) => {
    const url = new URL(request.url);
    const meetingId = url.searchParams.get("meeting_id");
    const agendaItemId = url.searchParams.get("agenda_item_id");
    const memberId = url.searchParams.get("member_id");

    let filtered = [...votes];
    if (meetingId) filtered = filtered.filter((v) => v.meeting_id === meetingId);
    if (agendaItemId) filtered = filtered.filter((v) => v.agenda_item_id === agendaItemId);
    if (memberId) filtered = filtered.filter((v) => v.member_id === memberId);

    filtered.sort(byCreatedAtDesc);

    return list(filtered);
  }),

  http.get("/api/anomalies", ({ request }) => {
    const url = new URL(request.url);
    const meetingId = url.searchParams.get("meeting_id");
    const severity = url.searchParams.get("severity");
    const flagType = url.searchParams.get("flag_type");

    let filtered = [...anomalyFlags];
    if (meetingId) filtered = filtered.filter((a) => a.meeting_id === meetingId);
    if (severity) filtered = filtered.filter((a) => a.severity === severity);
    if (flagType) filtered = filtered.filter((a) => a.flag_type === flagType);

    filtered.sort(byCreatedAtDesc);

    return list(filtered);
  }),

  /**
   * P6 · `GET /api/search`.
   *
   * A substring match over the fixtures, not a reimplementation of Postgres.
   * The point of this handler is the *shape* — the discriminated union, the
   * `{ data, total, query }` envelope, and matches delimited with the same
   * control characters `ts_headline` uses — so the page is exercised against
   * what the API really returns. Ranking and stemming are the backend's
   * problem and are asserted there, against a real database.
   *
   * Only published meetings are searched here too. The wall is enforced in the
   * backend and tested there; mirroring it means no frontend test can be
   * written against a fixture the real API would never serve.
   */
  http.get("/api/search", ({ request }) => {
    const url = new URL(request.url);
    const query = (url.searchParams.get("q") ?? "").trim();
    if (query === "") return HttpResponse.json({ data: [], total: 0, query });

    const needle = query.toLowerCase();
    const hit = (value: string | null | undefined): boolean =>
      typeof value === "string" && value.toLowerCase().includes(needle);

    /** Wraps every occurrence of the term the way ts_headline delimits a match. */
    const mark = (value: string | null | undefined): string => {
      if (typeof value !== "string" || value === "") return "";
      const parts = value.split(new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
      return parts
        .map((part) => (part.toLowerCase() === needle ? `\u0002${part}\u0003` : part))
        .join("");
    };

    const published = new Set(
      meetings.filter((m) => m.published_at !== null).map((m) => m.id),
    );
    const results: unknown[] = [];

    for (const item of agendaItems) {
      if (!published.has(item.meeting_id)) continue;
      if (!hit(item.title) && !hit(item.description)) continue;
      const meeting = meetings.find((m) => m.id === item.meeting_id);
      results.push({
        kind: "agenda_item",
        id: item.id,
        title: item.title,
        snippet: mark(item.description ?? item.title),
        rank: hit(item.title) ? 1 : 0.4,
        meeting_id: item.meeting_id,
        meeting_date: meeting?.date ?? "",
        commission_name: meeting?.commission?.name ?? "",
        jurisdiction_name: meeting?.commission?.jurisdiction?.name ?? "",
        item_number: item.item_number,
      });
    }

    for (const meeting of meetings) {
      if (meeting.published_at === null || !hit(meeting.location)) continue;
      results.push({
        kind: "meeting",
        id: meeting.id,
        title: meeting.commission?.name ?? "Commission meeting",
        snippet: mark(meeting.location),
        rank: 0.2,
        meeting_id: meeting.id,
        meeting_date: meeting.date,
        commission_name: meeting.commission?.name ?? "",
        jurisdiction_name: meeting.commission?.jurisdiction?.name ?? "",
      });
    }

    for (const member of members) {
      if (!hit(member.name) && !hit(member.title)) continue;
      results.push({
        kind: "member",
        id: member.id,
        title: member.name,
        snippet: mark(member.title),
        rank: hit(member.name) ? 1 : 0.4,
        jurisdiction_name: member.jurisdiction?.name ?? "",
      });
    }

    results.sort((a, b) => (b as { rank: number }).rank - (a as { rank: number }).rank);
    return HttpResponse.json({ data: results, total: results.length, query });
  }),

  /**
   * P7 · the public-records generator.
   *
   * Empty by default. The generator's own suite supplies its fixtures; what
   * this handler is for is the chrome walk, which mounts every colophon
   * destination and would otherwise hit an unhandled request on this one.
   */
  http.get("/api/public-records/gaps", () => list([])),

  /**
   * B3 · the public corrections log.
   *
   * Empty by default, for the same reason as the gaps handler above: the
   * corrections suite supplies its own fixtures, and what this is for is the
   * chrome walk, which now mounts `/corrections` from the colophon and would
   * otherwise hit an unhandled request.
   */
  http.get("/api/corrections", () => list([])),

  /**
   * The public meeting calendar, and the export manifest behind `/data`.
   *
   * Empty and minimal by default, for the same reason as the two handlers
   * above: the chrome walk now mounts `/calendar` from the masthead and `/data`
   * from the colophon, and each suite supplies its own fixtures.
   */
  http.get("/api/calendar", () => list([])),
  http.get("/api/data", () =>
    HttpResponse.json({
      generated_at: "2026-08-10T00:00:00.000Z",
      schema_migration: "039_create_record_disputes.ts",
      attribution: "CommissionWatch — commissionwatch.bmux.sh",
      license: {
        dataset: {
          name: "CC BY 4.0",
          url: "https://creativecommons.org/licenses/by/4.0/",
          covers: "The compiled dataset.",
          attribution:
            "Data from CommissionWatch — commissionwatch.bmux.sh, CC BY 4.0.",
        },
        code: { name: "MIT", url: null, covers: "The repository." },
        documents: {
          name: "No licence asserted",
          url: null,
          covers: "The government documents.",
        },
      },
      republication_request: "Republish a finding's corrections status with it.",
      publication_rule: "Only records an operator has published appear here.",
      datasets: [],
    }),
  ),
];
