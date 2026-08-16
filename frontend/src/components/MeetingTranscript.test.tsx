import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { http, HttpResponse } from "msw";
import { server } from "@/mocks/server";
import { MeetingTranscript } from "./MeetingTranscript";
import type {
  MeetingDocument,
  MeetingTranscriptDocument,
  MeetingTranscriptState,
  MeetingTranscriptSummary,
  TranscriptCoverageRow,
} from "@/types";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/**
 * The three states of `transcript_status` are three different statements, and
 * this suite exists so no redesign can quietly merge two of them.
 *
 * **Two paths through the component, and both are exercised below.** Since
 * 2026-08-15 `GET /api/meetings/:id` carries a `transcript` field and the
 * meeting page states this meeting's transcript per document; the year-coverage
 * describe further down covers what the component still says when the response
 * has no such field, which is what an older backend sends. The tests that omit
 * the `transcript` prop are the fallback's, and they are written that way on
 * purpose — passing `null` would be a different case entirely, because `null`
 * is the API saying this meeting has no transcript document at all.
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

/**
 * Omitting `transcript` is the fallback path, not the empty one. See the header:
 * `undefined` means the response carried no such key.
 */
function renderSection(
  documents: MeetingDocument[] = [],
  transcript?: MeetingTranscriptSummary | null,
) {
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
          transcript={transcript}
          documents={documents}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/* ------------------------------------------------ per-meeting fixtures */

function entry(
  state: MeetingTranscriptState,
  overrides: Partial<MeetingTranscriptDocument> = {},
): MeetingTranscriptDocument {
  // The shape the backend actually builds: `cue_count` is a number exactly for
  // the states where bytes were read, and `observed_sha256` is null only where
  // there were none. `meetingTranscript` derives both, and a fixture that
  // invented a cue count for `unavailable` would test a response the API cannot
  // send.
  const read = state === "published" || state === "absent";
  return {
    meeting_document_id: "8f1d0c66-6666-4a00-9000-00000000000a",
    clip_id: state === "unchecked" ? null : "2325",
    state,
    cue_count: read ? (state === "absent" ? 0 : 1284) : null,
    observed_sha256:
      state === "unavailable" || state === "unchecked"
        ? null
        : "a".repeat(64),
    last_checked_at: state === "unchecked" ? null : "2024-12-04T00:00:00.000Z",
    ...overrides,
  };
}

function summary(documents: MeetingTranscriptDocument[]): MeetingTranscriptSummary {
  return {
    documents,
    published: documents.filter((d) => d.state === "published").length,
    absent: documents.filter((d) => d.state === "absent").length,
    unavailable: documents.filter((d) => d.state === "unavailable").length,
    unchecked: documents.filter((d) => d.state === "unchecked").length,
    checked_through: "2024-12-04T00:00:00.000Z",
  };
}

/**
 * What the meeting page says now that it no longer has to reason about a year.
 *
 * The two things this describe is guarding are the two the backend went out of
 * its way to make expressible. A sitting Bozeman files as two clips is two
 * statements and neither may stand for the other — the first half publishing
 * does not make the second half published. And `transcript: null` is a fifth
 * state: `unchecked` says there is a recording nobody has asked about, `null`
 * says there is no recording to ask about, and a page that rendered one of
 * those sentences for the other would be reporting our backlog as the
 * custodian's archive or the reverse.
 */
describe("MeetingTranscript · per meeting", () => {
  it("states both halves of a split sitting, and collapses neither", async () => {
    const first = entry("published", {
      meeting_document_id: "8f1d0c66-6666-4a00-9000-00000000000a",
      clip_id: "2325",
    });
    const second = entry("unavailable", {
      meeting_document_id: "8f1d0c66-6666-4a00-9000-00000000000b",
      clip_id: "2326",
    });
    renderSection([], summary([first, second]));

    const rendered = await screen.findAllByTestId("transcript-document");
    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toHaveAttribute("data-state", "published");
    expect(rendered[1]).toHaveAttribute("data-state", "unavailable");

    // The published half must not speak for the unavailable one, and the page
    // must say out loud that there are two — a reader who missed that would
    // take the first sentence for the meeting's.
    expect(rendered[0].textContent).toContain("The custodian published captions");
    expect(rendered[1].textContent).toContain("That is a failure on our side");
    expect(
      screen.getByText(/The custodian files this sitting as/),
    ).toHaveTextContent("2");
  });

  it("says something different about no recording than about an unchecked one", async () => {
    const { unmount } = renderSection([], null);
    const none = await screen.findByTestId("transcript-none");
    expect(none.textContent).toContain(
      "The record shows no recording of this meeting.",
    );
    expect(none.textContent).toContain(
      "there is no clip filed against this meeting to ask about",
    );
    unmount();

    renderSection([], summary([entry("unchecked")]));
    const unchecked = await screen.findByTestId("transcript-document");
    expect(unchecked).toHaveAttribute("data-state", "unchecked");
    expect(unchecked.textContent).toContain(
      "No sweep has collected transcript yet.",
    );
    expect(unchecked.textContent).toContain(
      "The archive lists this recording.",
    );
    // The fifth state's sentence must not appear on the fourth's.
    expect(unchecked.textContent).not.toContain("The record shows no recording");
    expect(screen.queryByTestId("transcript-none")).not.toBeInTheDocument();
  });

  it("does not blame us for a caption file the custodian served empty", async () => {
    renderSection([], summary([entry("absent")]));

    const rendered = await screen.findByTestId("transcript-document");
    expect(rendered.textContent).toContain("The source published no transcript here.");
    expect(rendered.textContent).toContain(
      "That is what the custodian published, not a document we failed to collect.",
    );
    // `<Absence>` appends the status-page link only for reasons that are ours.
    expect(
      screen.queryByRole("link", { name: /collection status/i }),
    ).not.toBeInTheDocument();
  });

  it("owns a transcript we could not fetch, and links to the status page", async () => {
    renderSection([], summary([entry("unavailable")]));

    const rendered = await screen.findByTestId("transcript-document");
    expect(rendered.textContent).toContain("That is a failure on our side");
    expect(rendered.textContent).not.toContain("The source published no");
    expect(screen.getByRole("link", { name: /collection status/i })).toHaveAttribute(
      "href",
      "/status",
    );
  });

  /**
   * `cue_count` is null for `unavailable` and `unchecked` and a number for
   * `published` and `absent`. The zero on an `absent` document is the
   * custodian's empty caption file and is worth printing; a zero printed where
   * we simply did not read any bytes would be indistinguishable from it, and
   * that is our ignorance published as their silence.
   */
  it("never prints an unknown cue count as zero", async () => {
    renderSection(
      [],
      summary([
        entry("absent", { meeting_document_id: "8f1d0c66-6666-4a00-9000-00000000000a" }),
        entry("unavailable", {
          meeting_document_id: "8f1d0c66-6666-4a00-9000-00000000000b",
        }),
        entry("unchecked", {
          meeting_document_id: "8f1d0c66-6666-4a00-9000-00000000000c",
        }),
      ]),
    );

    const rendered = await screen.findAllByTestId("transcript-document");
    expect(rendered[0].textContent).toContain("0 caption cues indexed");
    // No figure at all, rather than a zero. `not.toContain("0")` would be the
    // wrong assertion — the `unavailable` entry prints a check date with a zero
    // in it, and what must never appear is a *count*.
    for (const unknown of [rendered[1], rendered[2]]) {
      expect(unknown.textContent).not.toMatch(/caption cues? indexed/);
    }
  });

  it("shows the cue count and the bytes it read for a published transcript", async () => {
    const captions: MeetingDocument = {
      ...captionFile,
      id: "8f1d0c66-6666-4a00-9000-00000000000a",
    };
    renderSection([captions], summary([entry("published")]));

    const rendered = await screen.findByTestId("transcript-document");
    expect(rendered.textContent).toContain("1284 caption cues indexed");
    expect(rendered.textContent).toContain("last checked 2024-12-04");
    // The hash is text, not a link: `observed_sha256` is deliberately not a
    // foreign key to `artifacts` (migration 089), so `/source/{sha}` would 404
    // on a hash that is nonetheless true of the bytes we read.
    expect(rendered.textContent).toContain("aaaaaaaaaaaa");
    expect(
      screen.queryByRole("link", { name: /aaaaaaaa/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: captions.title }),
    ).toHaveAttribute("href", captions.url);
  });
});

describe("MeetingTranscript · year-coverage fallback", () => {
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
