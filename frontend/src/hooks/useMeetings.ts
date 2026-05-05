import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type {
  Meeting,
  AgendaItem,
  MeetingDocument,
  RundownSheet,
  Jurisdiction,
} from "@/types";

export interface MeetingsFilter {
  jurisdiction_id?: string;
  status?: string;
  date_from?: string;
  date_to?: string;
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
    queryFn: () => fetchJson<Meeting[]>(`/meetings${buildQuery(filters)}`),
  });
}

export function useMeeting(id: string) {
  return useQuery({
    queryKey: ["meetings", id],
    queryFn: () => fetchJson<Meeting>(`/meetings/${id}`),
    enabled: !!id,
  });
}

export function useAgendaItems(meetingId: string) {
  return useQuery({
    queryKey: ["meetings", meetingId, "agenda-items"],
    queryFn: () =>
      fetchJson<AgendaItem[]>(`/meetings/${meetingId}/agenda-items`),
    enabled: !!meetingId,
  });
}

export function useMeetingDocuments(meetingId: string) {
  return useQuery({
    queryKey: ["meetings", meetingId, "documents"],
    queryFn: () =>
      fetchJson<MeetingDocument[]>(`/meetings/${meetingId}/documents`),
    enabled: !!meetingId,
  });
}

export function useRundown(meetingId: string) {
  return useQuery({
    queryKey: ["meetings", meetingId, "rundown"],
    queryFn: () => fetchJson<RundownSheet>(`/meetings/${meetingId}/rundown`),
    enabled: !!meetingId,
  });
}

export function useJurisdictions() {
  return useQuery({
    queryKey: ["jurisdictions"],
    queryFn: () => fetchJson<Jurisdiction[]>("/jurisdictions"),
  });
}
