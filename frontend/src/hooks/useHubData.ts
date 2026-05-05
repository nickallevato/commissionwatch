import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "../lib/api";
import type { Signal, PipelineSegment, ComplianceItem } from "../types/hub";

export function useSignals(dealId: string) {
  return useQuery({
    queryKey: ["signals", dealId],
    queryFn: () => fetchJson<Signal[]>(`/deals/${dealId}/signals`),
    staleTime: 30_000,
  });
}

export function usePipeline(dealId: string) {
  return useQuery({
    queryKey: ["pipeline", dealId],
    queryFn: () => fetchJson<PipelineSegment[]>(`/deals/${dealId}/pipeline`),
    staleTime: 60_000,
  });
}

export function useCompliance(dealId: string) {
  return useQuery({
    queryKey: ["compliance", dealId],
    queryFn: () => fetchJson<ComplianceItem[]>(`/deals/${dealId}/compliance`),
    staleTime: 60_000,
  });
}
