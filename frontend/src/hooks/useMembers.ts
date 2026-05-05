import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { Member, PaginatedResponse } from "@/types";

export function useMembers(jurisdictionId?: string) {
  const qs = jurisdictionId ? `?jurisdiction_id=${jurisdictionId}` : "";
  return useQuery({
    queryKey: ["members", { jurisdictionId }],
    queryFn: async () => {
      const res = await fetchJson<PaginatedResponse<Member>>(
        `/members${qs}`,
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
