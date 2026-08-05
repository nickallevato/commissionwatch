import { useQuery } from "@tanstack/react-query";
import { fetchList } from "@/lib/api";
import type { AnomalyFlag } from "@/types";

export interface AnomaliesFilter {
  meeting_id?: string;
  severity?: string;
  flag_type?: string;
}

function buildQuery(filters: AnomaliesFilter): string {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function useMeetingAnomalies(meetingId: string) {
  return useQuery({
    queryKey: ["anomalies", { meetingId }],
    queryFn: async () => {
      const res = await fetchList<AnomalyFlag>(
        `/anomalies?meeting_id=${meetingId}`,
      );
      return res.data;
    },
    enabled: !!meetingId,
  });
}

export function useAnomalies(filters: AnomaliesFilter = {}) {
  return useQuery({
    queryKey: ["anomalies", filters],
    queryFn: async () => {
      const res = await fetchList<AnomalyFlag>(
        `/anomalies${buildQuery(filters)}`,
      );
      return res.data;
    },
  });
}
