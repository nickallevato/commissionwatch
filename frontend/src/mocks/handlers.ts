import { http, HttpResponse } from "msw";
import {
  meetings,
  jurisdictions,
  agendaItems,
  meetingDocuments,
  rundownSheets,
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

  http.get("/api/jurisdictions", () => {
    return HttpResponse.json(jurisdictions);
  }),
];
