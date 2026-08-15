import { describe, it, expect } from "vitest";
import { render as baseRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { Citation, ReviewStamp, type CitationRef } from "./Citation";
import { abbreviateSha, sourceHref } from "./citation-source";

/**
 * A router, because the content address is now an in-app `Link` to
 * `/source/{sha}` rather than a bare anchor.
 */
function render(ui: ReactElement) {
  return baseRender(ui, { wrapper: MemoryRouter });
}

const REF: CitationRef = {
  artifact_sha256: "a".repeat(32) + "b".repeat(32),
  quote_offset: 4211,
  quote: "Commissioner Sample voted no on the motion to adopt Ordinance 2145.",
  source_label: "Minutes, Bozeman City Commission, 12 March 2026",
  source_url: "https://example.invalid/minutes-0312.pdf",
};

/**
 * What this suite protects is the shape of a citation, not its styling. The
 * failure mode is a surface rendering a source line that looks like a citation
 * and cannot be checked.
 */
describe("Citation", () => {
  it("shows the quote verbatim, because the quote is the claim", () => {
    render(<Citation citation={REF} />);
    expect(screen.getByText(new RegExp(REF.quote.slice(0, 40)))).toBeInTheDocument();
  });

  it("shows the content address, abbreviated but recoverable in full", () => {
    render(<Citation citation={REF} />);
    const sha = screen.getByTitle(REF.artifact_sha256);
    expect(sha).toHaveTextContent("aaaaaa");
    expect(sha).toHaveTextContent("bbbbbb");
  });

  /**
   * This test's premise changed when `SourcePage` shipped. It used to assert
   * the *absence* of a link, because linking at a route that did not exist
   * renders the 404 page inside the site chrome and reads as a broken record.
   * The route exists now, so the same reasoning demands the opposite assertion:
   * an unlinked address is a citation a reader cannot check, which makes it
   * decoration.
   */
  it("links the address at the source viewer, now that the viewer exists", () => {
    render(<Citation citation={REF} />);
    expect(screen.getByRole("link", { name: /aaaaaa/ })).toHaveAttribute(
      "href",
      `/source/${REF.artifact_sha256}?offset=4211&len=${REF.quote.length}`,
    );
  });

  /**
   * The offset rides in the query string because the *server* picks the window
   * — `readSourceWindow` centres 2,000 characters on it. A fragment never
   * leaves the browser, so `#offset-4211` would open the head of the document
   * and leave the reader to find the quote. `len` is the quote's own length,
   * which nothing but the citation knows.
   */
  it("carries the offset and the quote length where the server can read them", () => {
    const href = sourceHref(REF);
    expect(href).not.toBeNull();
    const url = new URL(href as string, "https://commissionwatch.bmux.sh");
    expect(url.pathname).toBe(`/source/${REF.artifact_sha256}`);
    expect(url.searchParams.get("offset")).toBe("4211");
    expect(url.searchParams.get("len")).toBe(String(REF.quote.length));
    expect(url.hash).toBe("");
  });

  /**
   * The upstream URL is labelled as where we got it, not as the citation. The
   * county's site reorganises; the hash does not. Presenting the URL as the
   * address would make every citation rot on their schedule.
   */
  it("labels the upstream link as provenance rather than as the address", () => {
    render(<Citation citation={REF} />);
    expect(screen.getByRole("link", { name: /where we got it/i })).toHaveAttribute(
      "href",
      REF.source_url as string,
    );
  });

  it("renders without an upstream URL, since the record may hold none", () => {
    render(<Citation citation={{ ...REF, source_url: null }} />);
    expect(screen.queryByRole("link", { name: /where we got it/i })).not.toBeInTheDocument();
    expect(screen.getByTitle(REF.artifact_sha256)).toBeInTheDocument();
  });

  it("abbreviates a long hash and leaves a short one alone", () => {
    expect(abbreviateSha("a".repeat(64))).toBe("aaaaaa…aaaaaa");
    expect(abbreviateSha("short")).toBe("short");
  });
});

describe("ReviewStamp", () => {
  it("says a person approved it, which is the guarantee that matters", () => {
    render(<ReviewStamp approved_at="2026-08-14T09:00:00Z" />);
    expect(screen.getByText(/approved for publication by an operator/i)).toBeInTheDocument();
  });

  /**
   * The audit trail records who. Publishing one maintainer's name beside every
   * finding invites a reader to argue with a person rather than with the record.
   */
  it("does not name the operator", () => {
    const { container } = render(<ReviewStamp approved_at="2026-08-14T09:00:00Z" />);
    expect(container.textContent).not.toMatch(/@/);
  });

  it("states a withdrawal rather than showing an approval date for it", () => {
    render(<ReviewStamp approved_at="2026-08-14T09:00:00Z" retracted_at="2026-08-20T09:00:00Z" />);
    expect(screen.getByText(/withdrawn on/i)).toBeInTheDocument();
    expect(screen.queryByText(/approved for publication/i)).not.toBeInTheDocument();
  });

  it("says unreviewed rather than rendering an empty date", () => {
    render(<ReviewStamp approved_at={null} />);
    expect(screen.getByText(/not yet reviewed for publication/i)).toBeInTheDocument();
  });
});
