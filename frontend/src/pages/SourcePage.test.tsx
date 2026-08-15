import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SourcePage } from "./SourcePage";
import { highlightSegments } from "@/hooks/useSource";
import { server } from "@/mocks/server";
import { SOURCE_SHA_WHOLE, SOURCE_SHA_WINDOWED, sourceWindows } from "@/mocks/data";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/source/:sha256" element={<SourcePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SourcePage", () => {
  it("headlines the document by how a reader should cite it", async () => {
    renderAt(`/source/${SOURCE_SHA_WHOLE}`);
    expect(
      await screen.findByRole("heading", { level: 1, name: /minutes, bozeman city commission/i }),
    ).toBeInTheDocument();
  });

  /**
   * The address is the hash. A reader who downloaded the file themselves can
   * hash it and compare, which is the strongest form of "check our work" this
   * project can offer — and it only works if the whole hash is on the page.
   */
  it("shows the content address in full, not abbreviated", async () => {
    renderAt(`/source/${SOURCE_SHA_WHOLE}`);
    expect(await screen.findByText(SOURCE_SHA_WHOLE)).toBeInTheDocument();
  });

  /**
   * The county reorganises its website; the bytes do not. Presenting the fetch
   * URL as the citation would make every citation on this site rot on their
   * schedule, so it is labelled as provenance and nothing else.
   */
  it("labels the upstream URL as where we got it, never as the address", async () => {
    renderAt(`/source/${SOURCE_SHA_WHOLE}`);
    expect(await screen.findByText(/where we got it/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "https://example.invalid/minutes-0312.pdf" }),
    ).toBeInTheDocument();
  });

  it("states the fetch time and the byte size", async () => {
    renderAt(`/source/${SOURCE_SHA_WHOLE}`);
    expect(await screen.findByText("2026-03-13 at 17:02 UTC")).toBeInTheDocument();
    expect(screen.getByText("148,233 bytes")).toBeInTheDocument();
  });

  it("says a document holds no fetch URL rather than rendering an empty cell", async () => {
    renderAt(`/source/${SOURCE_SHA_WINDOWED}`);
    await screen.findByRole("heading", { level: 1, name: /agenda packet/i });
    expect(screen.getAllByText("Not recorded.").length).toBeGreaterThan(0);
  });

  /**
   * The load-bearing one. A 2,000-character window presented without saying so
   * is a lie of omission about the document's length — on a site that publishes
   * a page about other people's omissions.
   */
  it("says out loud that a truncated response is a slice, not the document", async () => {
    renderAt(`/source/${SOURCE_SHA_WINDOWED}`);
    expect(
      await screen.findByText(/window around the quote, not the whole document/i),
    ).toBeInTheDocument();
    expect(screen.getByText("12,000")).toBeInTheDocument();
    expect(screen.getByText("41,820")).toBeInTheDocument();
  });

  it("says the reader has the whole text when nothing was cut", async () => {
    renderAt(`/source/${SOURCE_SHA_WHOLE}`);
    expect(await screen.findByText(/whole extracted text of the document/i)).toBeInTheDocument();
  });

  /**
   * `offset` is a position in the document; the window is a slice of it. The
   * page must subtract `window_start`, and the fixture's non-zero start is
   * there precisely so a page that forgot to would mark the wrong words.
   */
  it("highlights the quote at an offset inside a windowed slice", async () => {
    const window = sourceWindows[SOURCE_SHA_WINDOWED];
    const quote = "Commissioner Sample voted no";
    const position = window.text.indexOf(quote);
    const offset = window.window_start + position;

    renderAt(`/source/${SOURCE_SHA_WINDOWED}?offset=${offset}&len=${quote.length}`);

    const mark = await screen.findByTestId("cited-quote");
    expect(mark).toHaveTextContent(quote);
  });

  it("renders the window unmarked when the link carries no quote length", async () => {
    renderAt(`/source/${SOURCE_SHA_WHOLE}?offset=20`);
    await screen.findByRole("heading", { level: 1, name: /minutes/i });
    expect(screen.queryByTestId("cited-quote")).not.toBeInTheDocument();
  });

  /**
   * `readSourceWindow` clamps an offset past the end of a re-extracted document
   * rather than 404ing, on the grounds that the wrong part of the right file
   * beats a page that reads as "we made this up". The reader still has to be
   * told the highlight is missing.
   */
  it("says so when the cited offset falls outside the window returned", async () => {
    renderAt(`/source/${SOURCE_SHA_WINDOWED}?offset=999999&len=20`);
    expect(
      await screen.findByText(/not inside the text shown/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("cited-quote")).not.toBeInTheDocument();
  });

  /**
   * The text came out of third-party PDFs and county HTML. It is rendered as
   * React text nodes — the same reason `services/search.ts` marks matches with
   * control characters instead of `<b>`.
   */
  it("renders document text as text, never as markup", async () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    server.use(
      http.get("/api/source/:sha256", () =>
        HttpResponse.json({ ...sourceWindows[SOURCE_SHA_WHOLE], text: hostile, char_count: hostile.length }),
      ),
    );

    const { container } = renderAt(`/source/${SOURCE_SHA_WHOLE}`);
    expect(await screen.findByText(hostile)).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  /**
   * Unknown hash, artifact attached to no meeting, and meeting withheld all
   * answer identically. Distinguishing them would let anyone enumerate what has
   * been ingested and not published — see `services/source-viewer.ts`.
   */
  it("treats unknown and withheld identically on a 404", async () => {
    renderAt(`/source/${"f".repeat(64)}`);
    expect(
      await screen.findByRole("heading", { level: 1, name: /source not found/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/no published source has this address/i)).toBeInTheDocument();
    expect(screen.queryByText(/withheld|unpublished meeting|does not exist/i)).toBeNull();
  });
});

describe("highlightSegments", () => {
  it("splits the window around the quote", () => {
    expect(highlightSegments("abcdefgh", 2, 3)).toEqual({
      before: "ab",
      match: "cde",
      after: "fgh",
    });
  });

  it("stops at the end of the window rather than reading past it", () => {
    expect(highlightSegments("abcdefgh", 6, 50)).toEqual({
      before: "abcdef",
      match: "gh",
      after: "",
    });
  });

  it("returns null for a position outside the window, in either direction", () => {
    expect(highlightSegments("abcdefgh", -1, 3)).toBeNull();
    expect(highlightSegments("abcdefgh", 8, 3)).toBeNull();
  });

  it("returns null when the citation gave no length to mark", () => {
    expect(highlightSegments("abcdefgh", 2, 0)).toBeNull();
  });
});
