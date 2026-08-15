import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { server } from "@/mocks/server";
import { MeetingTranscript } from "./MeetingTranscript";
import type { MeetingDocument, TranscriptCoverageRow } from "@/types";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/**
 * The three states of `transcript_status` are three different statements, and
 * this suite exists so no redesign can quietly merge two of them.
 *
 * `absent` is the custodian serving an 8-byte empty caption file — a fact about
 * their record, era-shaped rather than random, and never a broken fetcher.
 * `unavailable` is us failing to fetch or parse, and it is ours. A page that
 * rendered the first as a failure would accuse a city of losing a record it
 * chose not to make; a page that rendered the second as an absence would
 * publish our outage as their silence. The assertions below check both the
 * sentence and the presence or absence of the status-page link, because the
 * link is what tells a reader whose problem it is.
 */

const JURISDICTION = "Fictional Springs";
const BODY = "Example Commission on Public Works";
const DATE = "2024-12-03";

function coverage(overrides: Partial<TranscriptCoverageRow>): TranscriptCoverageRow {
  return {
    jurisdiction: JURISDICTION,
    body: BODY,
    year: 2024,
    published: 0,
    absent: 0,
    unavailable: 0,
    unchecked: 0,
    checked_through: "2024-12-04T00:00:00Z",
    ...overrides,
  };
}

const captionFile: MeetingDocument = {
  id: "8f1d0c66-6666-4a00-9000-00000000000a",
  meeting_id: "8f1d0c66-1111-4a00-9000-000000000001",
  title: "Captions — City Commission Meeting",
  document_type: "transcript",
  url: "https://example.invalid/videos/2325/captions.vtt",
  created_at: "2024-12-04T00:00:00.000Z",
  updated_at: "2024-12-04T00:00:00.000Z",
};

function install(rows: TranscriptCoverageRow[]) {
  server.use(
    http.get("/api/transcripts/coverage", () =>
      HttpResponse.json({ coverage: rows }),
    ),
  );
}

function renderSection(documents: MeetingDocument[] = []) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <MeetingTranscript
          jurisdiction={JURISDICTION}
          body={BODY}
          date={DATE}
          documents={documents}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MeetingTranscript", () => {
  it("states the transcript's presence and links to it when captions were published", async () => {
    install([coverage({ published: 14 })]);
    renderSection([captionFile]);

    const panel = await screen.findByTestId("transcript-published");
    expect(panel.textContent).toContain("The custodian published captions");
    const link = screen.getByRole("link", { name: captionFile.title });
    expect(link).toHaveAttribute("href", captionFile.url);
  });

  it("says the source published nothing, and does not blame us, when the file is empty", async () => {
    install([coverage({ absent: 11 })]);
    renderSection([captionFile]);

    const panel = await screen.findByTestId("transcript-absent");
    expect(panel.textContent).toContain("The source published no transcript here.");
    expect(panel.textContent).toContain(
      "That is what the custodian published, not a document we failed to collect.",
    );
    // `<Absence>` appends the status-page link only for reasons that are ours.
    // Its presence here would be the page taking the blame for the city's
    // choice, which is precisely the conflation this feature exists to stop.
    expect(
      screen.queryByRole("link", { name: /collection status/i }),
    ).not.toBeInTheDocument();
  });

  it("says a transcript we could not collect is ours, and links to the status page", async () => {
    install([coverage({ unavailable: 3 })]);
    renderSection([captionFile]);

    const panel = await screen.findByTestId("transcript-unavailable");
    expect(panel.textContent).toContain("That is a failure on our side");
    expect(panel.textContent).not.toContain("The source published no");
    expect(screen.getByRole("link", { name: /collection status/i })).toHaveAttribute(
      "href",
      "/status",
    );
  });

  /**
   * A mixed year licenses no statement about one sitting inside it. Reporting
   * the majority state would put "the city published nothing" on the page of a
   * meeting our own fetcher may have been the one to miss.
   */
  it("reports the year rather than guessing when the year is mixed", async () => {
    install([coverage({ published: 9, absent: 4, unavailable: 2, unchecked: 6 })]);
    renderSection([captionFile]);

    const panel = await screen.findByTestId("transcript-year");
    expect(panel.textContent).toContain("We do not publish a per-meeting transcript state yet");
    expect(panel.textContent).toContain("9");
    expect(panel.textContent).toContain("4");
    expect(panel.textContent).toContain("2");
    expect(panel.textContent).toContain("6");
    expect(screen.queryByTestId("transcript-absent")).not.toBeInTheDocument();
    expect(screen.queryByTestId("transcript-published")).not.toBeInTheDocument();
  });

  it("says no sweep has collected transcripts for a body with no coverage at all", async () => {
    install([]);
    renderSection();

    expect(
      await screen.findByText(
        /No sweep has collected transcripts for this body yet\./,
      ),
    ).toBeInTheDocument();
  });

  it("treats a failed coverage request as ours rather than as an empty record", async () => {
    server.use(
      http.get("/api/transcripts/coverage", () =>
        HttpResponse.json({ error: "boom", statusCode: 500 }, { status: 500 }),
      ),
    );
    renderSection([captionFile]);

    expect(
      await screen.findByText(/The transcript record could not be loaded\./),
    ).toBeInTheDocument();
  });
});
