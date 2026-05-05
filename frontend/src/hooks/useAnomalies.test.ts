import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useMeetingAnomalies, useAnomalies } from "./useAnomalies";
import { server } from "@/mocks/server";
import { beforeAll, afterAll, afterEach, describe, it, expect } from "vitest";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

describe("useMeetingAnomalies", () => {
  it("fetches anomalies for a meeting", async () => {
    const { result } = renderHook(() => useMeetingAnomalies("m1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.length).toBeGreaterThan(0);
    for (const a of result.current.data!) {
      expect(a.meeting_id).toBe("m1");
    }
  });
});

describe("useAnomalies", () => {
  it("fetches all anomalies", async () => {
    const { result } = renderHook(() => useAnomalies(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.length).toBeGreaterThan(0);
  });

  it("filters by severity", async () => {
    const { result } = renderHook(() => useAnomalies({ severity: "critical" }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    for (const a of result.current.data!) {
      expect(a.severity).toBe("critical");
    }
  });
});
