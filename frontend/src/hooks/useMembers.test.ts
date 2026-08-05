import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useMembers, useMember } from "./useMembers";
import { server } from "@/mocks/server";
import { members } from "@/mocks/data";
import { beforeAll, afterAll, afterEach, describe, it, expect } from "vitest";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

describe("useMembers", () => {
  it("fetches all members", async () => {
    const { result } = renderHook(() => useMembers(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.length).toBeGreaterThan(0);
    expect(result.current.data![0]).toHaveProperty("name");
  });

  it("filters by jurisdiction", async () => {
    const jurisdictionId = members[0].jurisdiction_id;
    const { result } = renderHook(() => useMembers(jurisdictionId), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // Guard against the filter matching nothing, which would make the
    // assertion below vacuous.
    expect(result.current.data!.length).toBeGreaterThan(0);
    for (const m of result.current.data!) {
      expect(m.jurisdiction_id).toBe(jurisdictionId);
    }
  });
});

describe("useMember", () => {
  it("fetches a single member", async () => {
    const member = members[0];
    const { result } = renderHook(() => useMember(member.id), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.name).toBe(member.name);
  });
});
