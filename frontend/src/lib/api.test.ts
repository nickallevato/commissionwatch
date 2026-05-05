import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchJson } from "./api";

describe("fetchJson", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches and returns JSON from the API", async () => {
    const mockData = { id: 1, name: "test" };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockData), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await fetchJson("/test");
    expect(result).toEqual(mockData);
    expect(fetch).toHaveBeenCalledWith("/api/test", expect.objectContaining({
      headers: { "Content-Type": "application/json" },
    }));
  });

  it("throws on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Not Found", { status: 404, statusText: "Not Found" }),
    );

    await expect(fetchJson("/missing")).rejects.toThrow("API error: 404 Not Found");
  });
});
