import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useMeetingVotes, useVotes } from "./useVotes";
import { server } from "@/mocks/server";
import { beforeAll, afterAll, afterEach, describe, it, expect } from "vitest";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

describe("useMeetingVotes", () => {
  it("fetches votes for a meeting", async () => {
    const { result } = renderHook(() => useMeetingVotes("m1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.length).toBeGreaterThan(0);
    for (const v of result.current.data!) {
      expect(v.meeting_id).toBe("m1");
    }
  });
});

describe("useVotes", () => {
  it("fetches all votes unfiltered", async () => {
    const { result } = renderHook(() => useVotes(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.length).toBeGreaterThan(0);
  });
});
