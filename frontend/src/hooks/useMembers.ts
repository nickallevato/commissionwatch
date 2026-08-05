import { useQuery } from "@tanstack/react-query";
import { fetchList, fetchOne } from "@/lib/api";
import type { Member } from "@/types";

export function useMembers(jurisdictionId?: string) {
  const qs = jurisdictionId ? `?jurisdiction_id=${jurisdictionId}` : "";
  return useQuery({
    queryKey: ["members", { jurisdictionId }],
    queryFn: async () => {
      const res = await fetchList<Member>(`/members${qs}`);
      return res.data;
    },
  });
}

export function useMember(id: string) {
  return useQuery({
    queryKey: ["members", id],
    queryFn: () => fetchOne<Member>(`/members/${id}`),
    enabled: !!id,
  });
}
