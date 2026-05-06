import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { Member } from "@/types";

export interface MembersFilter {
  jurisdiction_id?: string;
}

function buildQuery(filters: MembersFilter): string {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function useMembers(filters: MembersFilter = {}) {
  return useQuery({
    queryKey: ["members", filters],
    queryFn: async () => {
      const res = await fetchJson<{ data: Member[]; total: number }>(
        `/members${buildQuery(filters)}`,
      );
      return res.data;
    },
  });
}

export function useMember(id: string) {
  return useQuery({
    queryKey: ["members", id],
    queryFn: () => fetchJson<Member>(`/members/${id}`),
    enabled: !!id,
  });
}
