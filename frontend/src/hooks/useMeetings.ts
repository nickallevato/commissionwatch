import { useQuery } from "@tanstack/react-query";
import { fetchList, fetchOne } from "@/lib/api";
import type {
  AgendaItem,
  Commission,
  DocumentTimeline,
  Jurisdiction,
  Meeting,
  MeetingDocument,
} from "@/types";

export interface MeetingsFilter {
  jurisdiction_id?: string;
  status?: string;
  date_from?: string;
  date_to?: string;
}

/**
 * `GET /api/meetings/:id` does not return a bare `meetings` row: the route
 * loads the agenda and the document list alongside it and spreads all three
 * into one object.
 */
export interface MeetingDetail extends Meeting {
  agenda_items: AgendaItem[];
  documents: MeetingDocument[];
}

/**
 * `GET /api/jurisdictions` embeds each jurisdiction's commissions rather than
 * serving them from a separate endpoint.
 */
export interface JurisdictionWithCommissions extends Jurisdiction {
  commissions: Commission[];
}

function buildQuery(filters: MeetingsFilter): string {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function useMeetings(filters: MeetingsFilter = {}) {
  return useQuery({
    queryKey: ["meetings", filters],
    queryFn: async () => {
      const res = await fetchList<Meeting>(`/meetings${buildQuery(filters)}`);
      return res.data;
    },
  });
}

export function useMeeting(id: string) {
  return useQuery({
    queryKey: ["meetings", id],
    queryFn: () => fetchOne<MeetingDetail>(`/meetings/${id}`),
    enabled: !!id,
  });
}

/**
 * Key and fetcher for one meeting's agenda, shared so the per-meeting fan-out
 * on the votes page lands on the same cache entries as `useAgendaItems`.
 */
export function agendaItemsQuery(meetingId: string) {
  return {
    queryKey: ["meetings", meetingId, "agenda-items"],
    queryFn: async () => {
      const res = await fetchList<AgendaItem>(
        `/meetings/${meetingId}/agenda-items`,
      );
      return res.data;
    },
  };
}

export function useAgendaItems(meetingId: string) {
  return useQuery({
    ...agendaItemsQuery(meetingId),
    enabled: !!meetingId,
  });
}

export function useMeetingDocuments(meetingId: string) {
  return useQuery({
    queryKey: ["meetings", meetingId, "documents"],
    queryFn: async () => {
      const res = await fetchList<MeetingDocument>(
        `/meetings/${meetingId}/documents`,
      );
      return res.data;
    },
    enabled: !!meetingId,
  });
}

/**
 * P5 — every version of every document on a meeting, with the diff between
 * each consecutive pair. Most meetings return one version per document and no
 * diffs at all, which is a complete answer.
 */
export function useAgendaDiff(meetingId: string) {
  return useQuery({
    queryKey: ["meetings", meetingId, "agenda-diff"],
    queryFn: async () => {
      const res = await fetchList<DocumentTimeline>(
        `/meetings/${meetingId}/agenda-diff`,
      );
      return res.data;
    },
    enabled: !!meetingId,
  });
}

export function useJurisdictions() {
  return useQuery({
    queryKey: ["jurisdictions"],
    queryFn: async () => {
      const res =
        await fetchList<JurisdictionWithCommissions>("/jurisdictions");
      return res.data;
    },
  });
}
