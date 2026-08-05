import { useQuery } from "@tanstack/react-query";
import { fetchList } from "@/lib/api";
import type { Vote } from "@/types";

export interface VotesFilter {
  meeting_id?: string;
  agenda_item_id?: string;
  member_id?: string;
}

function buildQuery(filters: VotesFilter): string {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function useMeetingVotes(meetingId: string) {
  return useQuery({
    queryKey: ["votes", { meetingId }],
    queryFn: async () => {
      const res = await fetchList<Vote>(`/votes?meeting_id=${meetingId}`);
      return res.data;
    },
    enabled: !!meetingId,
  });
}

export function useVotes(filters: VotesFilter = {}) {
  return useQuery({
    queryKey: ["votes", filters],
    queryFn: async () => {
      const res = await fetchList<Vote>(`/votes${buildQuery(filters)}`);
      return res.data;
    },
  });
}
