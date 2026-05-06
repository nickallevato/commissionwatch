import { http, HttpResponse } from "msw";
import {
  meetings,
  jurisdictions,
  agendaItems,
  meetingDocuments,
  rundownSheets,
  members,
  votes,
  anomalyFlags,
} from "./data";

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

    return HttpResponse.json(filtered);
  }),

  http.get("/api/meetings/:id", ({ params }) => {
    const meeting = meetings.find((m) => m.id === params.id);
    if (!meeting) return new HttpResponse(null, { status: 404 });
    return HttpResponse.json(meeting);
  }),

  http.get("/api/meetings/:id/agenda-items", ({ params }) => {
    const items = agendaItems
      .filter((a) => a.meeting_id === params.id)
      .sort((a, b) => a.item_number - b.item_number);
    return HttpResponse.json(items);
  }),

  http.get("/api/meetings/:id/documents", ({ params }) => {
    const docs = meetingDocuments.filter((d) => d.meeting_id === params.id);
    return HttpResponse.json(docs);
  }),

  http.get("/api/meetings/:id/rundown", ({ params }) => {
    const rundown = rundownSheets.find((r) => r.meeting_id === params.id);
    if (!rundown) return new HttpResponse(null, { status: 404 });
    return HttpResponse.json(rundown);
  }),

  http.get("/api/meetings/:id/votes", ({ params }) => {
    const data = votes.filter((v) => v.meeting_id === params.id);
    return HttpResponse.json({ data, total: data.length });
  }),

  http.get("/api/meetings/:id/anomalies", ({ params }) => {
    const data = anomalyFlags.filter((a) => a.meeting_id === params.id);
    return HttpResponse.json({ data, total: data.length });
  }),

  http.get("/api/jurisdictions", () => {
    return HttpResponse.json(jurisdictions);
  }),

  http.get("/api/members", ({ request }) => {
    const url = new URL(request.url);
    const jurisdictionId = url.searchParams.get("jurisdiction_id");

    let filtered = [...members];
    if (jurisdictionId) {
      filtered = filtered.filter((m) => m.jurisdiction_id === jurisdictionId);
    }

    return HttpResponse.json({ data: filtered, total: filtered.length });
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

    return HttpResponse.json({ data: filtered, total: filtered.length });
  }),

  http.get("/api/votes/:id", ({ params }) => {
    const vote = votes.find((v) => v.id === params.id);
    if (!vote) return new HttpResponse(null, { status: 404 });
    return HttpResponse.json(vote);
  }),

  http.get("/api/anomalies", ({ request }) => {
    const url = new URL(request.url);
    const meetingId = url.searchParams.get("meeting_id");
    const flagType = url.searchParams.get("flag_type");
    const severity = url.searchParams.get("severity");

    let filtered = [...anomalyFlags];
    if (meetingId) filtered = filtered.filter((a) => a.meeting_id === meetingId);
    if (flagType) filtered = filtered.filter((a) => a.flag_type === flagType);
    if (severity) filtered = filtered.filter((a) => a.severity === severity);

    return HttpResponse.json({ data: filtered, total: filtered.length });
  }),

  http.get("/api/anomalies/:id", ({ params }) => {
    const anomaly = anomalyFlags.find((a) => a.id === params.id);
    if (!anomaly) return new HttpResponse(null, { status: 404 });
    return HttpResponse.json(anomaly);
  }),
];
