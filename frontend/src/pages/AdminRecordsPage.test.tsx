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

/** P7 fixtures. Invented, and the citation deliberately is not a real one. */
const GAP = {
  id: "missing_minutes:11111111-2222-3333-4444-555555555555",
  kind: "missing_minutes",
  jurisdiction_name: "Example County",
  summary: "No minutes are in the record for the Example Commission meeting of 2026-08-04.",
};

const VERIFIED_LAW = {
  jurisdiction_id: "j1",
  jurisdiction_name: "Example County",
  law: { statute_citation: "Example Code Ann. \u00a7 0-0-0000", verified_on: "2026-08-01" },
  verification_age_days: 9,
  stale: false,
  advisory: "Verified 2026-08-01.",
};

const NO_LAW = {
  jurisdiction_id: "j2",
  jurisdiction_name: "Nowhere County",
  law: null,
  verification_age_days: null,
  stale: false,
  advisory:
    "No row in jurisdiction_records_law. No request can be drafted for this jurisdiction " +
    "until a person reads the applicable subsection.",
};

function baseHandlers(options: { gaps?: unknown[]; law?: unknown[] } = {}) {
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
    http.get("/api/admin/records/gaps", () => {
      const gaps = options.gaps ?? [GAP];
      return HttpResponse.json({ data: gaps, total: gaps.length });
    }),
    http.get("/api/admin/records/law", () => {
      const law = options.law ?? [VERIFIED_LAW, NO_LAW];
      return HttpResponse.json({ data: law, total: law.length });
    }),
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

  /* ---- P7: the request generator ---------------------------------- */

  it("names a jurisdiction with no statute on file rather than hiding it", async () => {
    server.use(...baseHandlers());
    renderWithProviders(<AdminRecordsPage />);

    await waitFor(() => expect(screen.getByText("Nowhere County")).toBeInTheDocument());
    expect(screen.getByText("No statute recorded")).toBeInTheDocument();
    expect(screen.getByText(/No row in jurisdiction_records_law/)).toBeInTheDocument();
    // The verified one reads as its citation, not as a warning.
    expect(screen.getByText("Example Code Ann. \u00a7 0-0-0000")).toBeInTheDocument();
  });

  it("warns when a verification is more than a year old", async () => {
    server.use(
      ...baseHandlers({
        law: [
          {
            ...VERIFIED_LAW,
            verification_age_days: 952,
            stale: true,
            advisory:
              "Last verified 2024-01-01, 952 days ago. Montana's public information sections " +
              "are marked Temporary and carry termination dates.",
          },
        ],
      }),
    );
    renderWithProviders(<AdminRecordsPage />);

    await waitFor(() =>
      expect(screen.getByText("Verification out of date")).toBeInTheDocument(),
    );
    expect(screen.getByText(/marked Temporary/)).toBeInTheDocument();
  });

  it("drafts a letter for a gap and keeps the request in draft", async () => {
    let posted: { gap_id?: string } | null = null;
    const letter = "2026-08-10\n\nPublic Records Custodian\nExample County";

    server.use(
      ...baseHandlers(),
      http.post("/api/admin/records/draft-request", async ({ request }) => {
        posted = (await request.json()) as { gap_id?: string };
        return HttpResponse.json(
          { letter, gap: GAP, law: {}, warnings: [], request: { id: "r2", status: "draft" } },
          { status: 201 },
        );
      }),
    );

    renderWithProviders(<AdminRecordsPage />);
    await waitFor(() => expect(screen.getByText(GAP.summary)).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText("Requester name"), "A. Requester");
    await userEvent.type(screen.getByLabelText("Requester email"), "requester@example.invalid");
    await userEvent.click(screen.getByRole("button", { name: "Draft request" }));

    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted!.gap_id).toBe(GAP.id);
    expect(await screen.findByLabelText("Draft letter")).toHaveValue(letter);
  });

  it("shows the refusal verbatim when a jurisdiction has no records law", async () => {
    const refusal =
      "No public-records law is on file for Nowhere County, so no letter was drafted. " +
      "Required before a request can cite anything: statute_citation, statute_url, verified_on.";

    server.use(
      ...baseHandlers(),
      http.post("/api/admin/records/draft-request", () =>
        HttpResponse.json({ error: refusal, statusCode: 409 }, { status: 409 }),
      ),
    );

    renderWithProviders(<AdminRecordsPage />);
    await waitFor(() => expect(screen.getByText(GAP.summary)).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Draft request" }));

    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((node) => /statute_citation/.test(node.textContent ?? ""))).toBe(true);
    expect(screen.queryByLabelText("Draft letter")).toBeNull();
  });

  it("puts the counts in tiles and reds the jurisdictions with no statute", async () => {
    // Screen 06's tile row. "No statute recorded" is not a cosmetic state: it
    // is the reason no letter can be drafted for that jurisdiction at all.
    server.use(...baseHandlers());
    renderWithProviders(<AdminRecordsPage />);

    await waitFor(() => expect(screen.getByText("Nowhere County")).toBeInTheDocument());
    expect(screen.getByText("Jurisdictions without a statute")).toBeInTheDocument();
    expect(screen.getByText("no letter can be drafted")).toBeInTheDocument();
    expect(screen.getByText("derived, not listed")).toBeInTheDocument();
  });

  it("offers a real file input as the dropzone, not a styled div", async () => {
    server.use(...baseHandlers());
    renderWithProviders(<AdminRecordsPage />);

    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Paving contracts 2026" })).toBeInTheDocument(),
    );
    expect(screen.getByLabelText(/Drop a document/)).toHaveAttribute("type", "file");
  });

  it("marks an extraction that names people as held, and says why nothing publishes", async () => {
    server.use(
      ...baseHandlers(),
      http.post("/api/admin/records/documents", () =>
        HttpResponse.json({ artifact: { id: ARTIFACT_ID }, created: true }, { status: 201 }),
      ),
      http.get("/api/admin/records/documents/:id/extraction", () =>
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

    const held = await screen.findByTestId("held-entities");
    expect(held).toHaveTextContent("2 persons");
    expect(held).toHaveTextContent("waits for the review queue");
    expect(screen.getByTestId("extraction-summary")).toHaveTextContent("2 — held");
  });
});
