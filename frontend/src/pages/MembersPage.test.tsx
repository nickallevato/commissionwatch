import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { renderWithProviders, screen, waitFor } from "@/lib/test-utils";
import { MembersPage } from "./MembersPage";
import { server } from "@/mocks/server";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("MembersPage", () => {
  it("renders officials heading", () => {
    renderWithProviders(<MembersPage />);
    expect(screen.getByText("Officials")).toBeInTheDocument();
  });

  it("renders member cards after loading", async () => {
    renderWithProviders(<MembersPage />);
    await waitFor(() => {
      expect(screen.getByText("Sarah Chen")).toBeInTheDocument();
    });
  });
});
