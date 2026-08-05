import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { renderWithProviders, screen, waitFor } from "@/lib/test-utils";
import { AnomaliesPage } from "./AnomaliesPage";
import { server } from "@/mocks/server";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("AnomaliesPage", () => {
  it("renders anomalies heading", () => {
    renderWithProviders(<AnomaliesPage />);
    expect(screen.getByText("Anomalies")).toBeInTheDocument();
  });

  it("renders anomaly cards after loading", async () => {
    renderWithProviders(<AnomaliesPage />);
    await waitFor(() => {
      expect(screen.getByText("Unanimous Controversial Vote")).toBeInTheDocument();
    });
  });
});
