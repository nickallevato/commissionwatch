import { http, HttpResponse } from "msw";
import {
  meetings,
  jurisdictions,
  commissions,
  agendaItems,
  meetingDocuments,
  rundownSheets,
  members,
  votes,
  anomalyFlags,
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

  http.get("/api/meetings/:id/rundown", ({ params }) => {
    const rundown = rundownSheets.find((r) => r.meeting_id === params.id);
    if (!rundown) return new HttpResponse(null, { status: 404 });
    return HttpResponse.json(rundown);
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
];
