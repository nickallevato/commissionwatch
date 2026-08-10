import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";
import { screen, waitFor } from "@testing-library/react";
import { PublicRecordsPage } from "./PublicRecordsPage";
import { renderWithProviders } from "@/lib/test-utils";
import { server } from "@/mocks/server";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/**
 * `/public-records` — the statutory route, offered to anyone.
 *
 * What this suite is really guarding: the page must never suggest that
 * CommissionWatch sends the letter. There is no send control, the standing text
 * says nothing is sent and nothing is stored, and the refusal from a
 * jurisdiction with no verified statute is rendered in full rather than reduced
 * to "something went wrong" — the refusal is the only part of that response
 * anybody can act on.
 */

const GAP = {
  id: "missing_minutes:11111111-2222-3333-4444-555555555555",
  kind: "missing_minutes",
  jurisdiction_name: "Example County",
  summary: "No minutes are in the record for the Example Commission meeting of 2026-08-04.",
  requested_record: "the minutes of the Example Commission meeting held on 2026-08-04",
  meeting_id: "22222222-3333-4444-5555-666666666666",
  meeting_date: "2026-08-04",
  commission_name: "Example Commission",
};

// Invented, like every fixture here. It must not read as a real citation.
const LETTER = [
  "2026-08-10",
  "",
  "Public Records Custodian",
  "Example County",
  "",
  "Under Example Code Ann. § 0-0-0000 (https://example.invalid/statute), I am requesting a copy",
  "of the following public record of Example County:",
].join("\n");

function gapsHandler(gaps: unknown[] = [GAP]) {
  return http.get("/api/public-records/gaps", () =>
    HttpResponse.json({ data: gaps, total: gaps.length }),
  );
}

describe("PublicRecordsPage", () => {
  it("says plainly that nothing is sent and nothing is stored", async () => {
    server.use(gapsHandler());
    renderWithProviders(<PublicRecordsPage />);

    expect(
      screen.getByText(/Nothing is sent on your behalf, and nothing you type here is stored/),
    ).toBeInTheDocument();
    // There is no send path anywhere in the product, so there is no control
    // here that could imply one.
    expect(screen.queryByRole("button", { name: /send/i })).toBeNull();
    await waitFor(() => expect(screen.getByText(GAP.summary)).toBeInTheDocument());
  });

  it("lists the gaps it is given and drafts a letter for the one chosen", async () => {
    let posted: { gap_id?: string; requester?: { name?: string } } | null = null;
    server.use(
      gapsHandler(),
      http.post("/api/public-records/letter", async ({ request }) => {
        posted = (await request.json()) as { gap_id?: string; requester?: { name?: string } };
        return HttpResponse.json({ letter: LETTER, gap: GAP, law: {}, warnings: [], request: null });
      }),
    );

    renderWithProviders(<PublicRecordsPage />);
    await waitFor(() => expect(screen.getByText(GAP.summary)).toBeInTheDocument());

    await userEvent.click(screen.getByRole("radio"));
    await userEvent.type(screen.getByLabelText("Name"), "A. Requester");
    await userEvent.type(screen.getByLabelText("Email"), "requester@example.invalid");
    await userEvent.click(screen.getByRole("button", { name: "Draft the letter" }));

    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted!.gap_id).toBe(GAP.id);
    expect(posted!.requester?.name).toBe("A. Requester");

    const textarea = await screen.findByLabelText("Letter text");
    expect(textarea).toHaveValue(LETTER);
    expect(textarea).toHaveAttribute("readonly");
  });

  it("cannot draft before a gap has been chosen", async () => {
    server.use(gapsHandler());
    renderWithProviders(<PublicRecordsPage />);
    await waitFor(() => expect(screen.getByText(GAP.summary)).toBeInTheDocument());

    expect(screen.getByRole("button", { name: "Draft the letter" })).toBeDisabled();
  });

  it("renders a refusal in full rather than reducing it to an error", async () => {
    const refusal =
      "No public-records law is on file for Example County, so no letter was drafted. " +
      "The table jurisdiction_records_law has no row for jurisdiction_id 1111. " +
      "Required before a request can cite anything: statute_citation, statute_url, verified_on.";

    server.use(
      gapsHandler(),
      http.post("/api/public-records/letter", () =>
        HttpResponse.json({ error: refusal, statusCode: 409 }, { status: 409 }),
      ),
    );

    renderWithProviders(<PublicRecordsPage />);
    await waitFor(() => expect(screen.getByText(GAP.summary)).toBeInTheDocument());

    await userEvent.click(screen.getByRole("radio"));
    await userEvent.type(screen.getByLabelText("Name"), "A. Requester");
    await userEvent.type(screen.getByLabelText("Email"), "requester@example.invalid");
    await userEvent.click(screen.getByRole("button", { name: "Draft the letter" }));

    const alert = await screen.findByRole("alert");
    // Verbatim: the table, the missing row and the columns to supply.
    expect(alert).toHaveTextContent(/jurisdiction_records_law/);
    expect(alert).toHaveTextContent(/statute_citation/);
    expect(alert).toHaveTextContent(/verified_on/);
    // And no letter appeared alongside it.
    expect(screen.queryByLabelText("Letter text")).toBeNull();
  });

  it("shows a stale-verification warning with the letter", async () => {
    const warning =
      "The statutory text for this jurisdiction was last verified on 2024-01-01, 952 days ago.";
    server.use(
      gapsHandler(),
      http.post("/api/public-records/letter", () =>
        HttpResponse.json({ letter: LETTER, gap: GAP, law: {}, warnings: [warning], request: null }),
      ),
    );

    renderWithProviders(<PublicRecordsPage />);
    await waitFor(() => expect(screen.getByText(GAP.summary)).toBeInTheDocument());
    await userEvent.click(screen.getByRole("radio"));
    await userEvent.type(screen.getByLabelText("Name"), "A. Requester");
    await userEvent.type(screen.getByLabelText("Email"), "requester@example.invalid");
    await userEvent.click(screen.getByRole("button", { name: "Draft the letter" }));

    expect(await screen.findByText(warning)).toBeInTheDocument();
  });

  it("says nothing is open rather than implying the record is complete", async () => {
    server.use(gapsHandler([]));
    renderWithProviders(<PublicRecordsPage />);

    await waitFor(() =>
      expect(
        screen.getByText(/a statement about what has been published, not about what exists/),
      ).toBeInTheDocument(),
    );
  });
});
