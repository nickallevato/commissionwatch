import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";
import { screen, waitFor } from "@testing-library/react";
import { AdminRecordsPage } from "./AdminRecordsPage";
import { renderWithProviders } from "@/lib/test-utils";
import { server } from "@/mocks/server";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const ARTIFACT_ID = "11111111-2222-3333-4444-555555555555";

interface ExtractedValueFixture {
  value: string;
  confidence: "high" | "medium" | "low";
  pattern: string;
}

interface ExtractionFixture {
  id: string;
  artifact_id: string;
  entities: {
    people: ExtractedValueFixture[];
    organizations: ExtractedValueFixture[];
    amounts: ExtractedValueFixture[];
    dates: ExtractedValueFixture[];
  };
  extractor_version: string;
  supersedes_id: string | null;
  note: string | null;
  created_at: string;
}

// Invented, as every fixture in this project is.
const EXTRACTION: ExtractionFixture = {
  id: "e1",
  artifact_id: ARTIFACT_ID,
  entities: {
    people: [
      { value: "Jordan Placeholder", confidence: "low", pattern: "capitalised word sequence" },
      { value: "Commission Room", confidence: "low", pattern: "capitalised word sequence" },
    ],
    organizations: [
      { value: "Fictional Paving LLC", confidence: "high", pattern: "organisational suffix" },
    ],
    amounts: [{ value: "$390,000", confidence: "high", pattern: "currency-marked amount" }],
    dates: [{ value: "2026-03-01", confidence: "high", pattern: "ISO 8601 date" }],
  },
  extractor_version: "1.0",
  supersedes_id: null,
  note: null,
  created_at: "2026-08-09T00:00:00.000Z",
};

function baseHandlers() {
  return [
    http.get("/api/admin/records/requests", () =>
      HttpResponse.json({
        data: [
          {
            id: "r1",
            subject: "Paving contracts 2026",
            status: "submitted",
            submitted_at: "2026-08-01T00:00:00.000Z",
            responded_at: null,
          },
        ],
        total: 1,
      }),
    ),
  ];
}

describe("AdminRecordsPage", () => {
  it("lists requests with their lifecycle status", async () => {
    server.use(...baseHandlers());
    renderWithProviders(<AdminRecordsPage />);

    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Paving contracts 2026" })).toBeInTheDocument(),
    );
    expect(screen.getByText("submitted")).toBeInTheDocument();
  });

  it("uploads a document and shows the extraction with per-field confidence", async () => {
    server.use(
      ...baseHandlers(),
      http.post("/api/admin/records/documents", () =>
        HttpResponse.json({ artifact: { id: ARTIFACT_ID }, created: true }, { status: 201 }),
      ),
      http.get(`/api/admin/records/documents/${ARTIFACT_ID}/extraction`, () =>
        HttpResponse.json({ current: EXTRACTION, history: [EXTRACTION] }),
      ),
    );

    renderWithProviders(<AdminRecordsPage />);
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Paving contracts 2026" })).toBeInTheDocument(),
    );

    await userEvent.type(screen.getByLabelText("Filename"), "award.txt");
    await userEvent.type(screen.getByLabelText("Document text"), "A sole source award.");
    await userEvent.click(screen.getByRole("button", { name: "Upload" }));

    await waitFor(() => expect(screen.getByText("Jordan Placeholder")).toBeInTheDocument());
    // The heuristic's weakness is stated in the data, not only in prose.
    expect(screen.getAllByText(/low · capitalised word sequence/)).toHaveLength(2);
    expect(screen.getByText(/high · organisational suffix/)).toBeInTheDocument();
  });

  it("says so when identical bytes were already stored", async () => {
    server.use(
      ...baseHandlers(),
      http.post("/api/admin/records/documents", () =>
        HttpResponse.json({ artifact: { id: ARTIFACT_ID }, created: false }, { status: 200 }),
      ),
      http.get(`/api/admin/records/documents/${ARTIFACT_ID}/extraction`, () =>
        HttpResponse.json({ current: EXTRACTION, history: [EXTRACTION] }),
      ),
    );

    renderWithProviders(<AdminRecordsPage />);
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Paving contracts 2026" })).toBeInTheDocument(),
    );

    await userEvent.type(screen.getByLabelText("Filename"), "again.txt");
    await userEvent.type(screen.getByLabelText("Document text"), "A sole source award.");
    await userEvent.click(screen.getByRole("button", { name: "Upload" }));

    // A re-upload must not look like it silently did nothing.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/already stored/i);
  });

  it("submits a correction as a whole replacement set, not an edit", async () => {
    let posted: { entities: { people: unknown[] } } | null = null;
    const corrected: ExtractionFixture = {
      ...EXTRACTION,
      id: "e2",
      supersedes_id: "e1",
      entities: { ...EXTRACTION.entities, people: [EXTRACTION.entities.people[0]] },
    };
    let served: ExtractionFixture = EXTRACTION;

    server.use(
      ...baseHandlers(),
      http.post("/api/admin/records/documents", () =>
        HttpResponse.json({ artifact: { id: ARTIFACT_ID }, created: true }, { status: 201 }),
      ),
      http.get(`/api/admin/records/documents/${ARTIFACT_ID}/extraction`, () =>
        HttpResponse.json({ current: served, history: [EXTRACTION, corrected].slice(0, served === EXTRACTION ? 1 : 2) }),
      ),
      http.post(`/api/admin/records/documents/${ARTIFACT_ID}/extraction`, async ({ request }) => {
        posted = (await request.json()) as { entities: { people: unknown[] } };
        served = corrected;
        return HttpResponse.json(corrected, { status: 201 });
      }),
    );

    renderWithProviders(<AdminRecordsPage />);
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Paving contracts 2026" })).toBeInTheDocument(),
    );
    await userEvent.type(screen.getByLabelText("Filename"), "award.txt");
    await userEvent.type(screen.getByLabelText("Document text"), "A sole source award.");
    await userEvent.click(screen.getByRole("button", { name: "Upload" }));

    await waitFor(() => expect(screen.getByText("Commission Room")).toBeInTheDocument());

    // "Commission Room" is a room, not a person. This is the case the whole
    // correction path exists for.
    const row = screen.getByText("Commission Room").closest("li");
    expect(row).not.toBeNull();
    const remove = row!.querySelector("button");
    expect(remove).not.toBeNull();
    await userEvent.click(remove!);

    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted!.entities.people).toHaveLength(1);
    // Two versions on record: the correction appended, it did not overwrite.
    await waitFor(() => expect(screen.getByText("2 versions on record")).toBeInTheDocument());
  });
});
