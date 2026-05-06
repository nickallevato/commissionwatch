import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { renderWithProviders, screen } from "../lib/test-utils";
import { AnomaliesPage } from "./AnomaliesPage";
import { server } from "../mocks/server";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("AnomaliesPage", () => {
  it("renders the heading", () => {
    renderWithProviders(<AnomaliesPage />);
    expect(screen.getByRole("heading", { name: "Anomalies" })).toBeInTheDocument();
  });
});
