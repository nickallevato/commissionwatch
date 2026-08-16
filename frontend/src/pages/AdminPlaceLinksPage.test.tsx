import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { AdminPlaceLinksPage } from "./AdminPlaceLinksPage";
import { server } from "@/mocks/server";
import type { PlaceLinkQueueResponse, PlaceLinkReviewItem } from "@/types";

/**
 * `/admin/place-links` — the screen from which a location becomes a pin on a
 * public map.
 *
 * What this suite guards is not layout. It is the seven things that make an
 * approval here mean something:
 *
 * **The quote is visible in the document, with the span marked.** An address is
 * the easiest thing in a document to attach to the wrong item.
 *
 * **The precision is on the page in words, next to the coordinate.** `block` is
 * a TIGER address-range interpolation and not a surveyed point. A grade rendered
 * as a bare column value tells an operator nothing about what they are
 * publishing.
 *
 * **The coordinate is not printed more finely than its grade supports.** Six
 * decimals on a block-grade latitude claims a metre nobody measured.
 *
 * **An inferred link cannot be approved and can be rejected.** The wall excludes
 * it whatever its status. The screen must reflect that rather than letting the
 * operator discover it through a 409.
 *
 * **A withheld subject does not block approval.** It must read as the wall
 * working, not as the screen being broken.
 *
 * **No decision without a stated reason.** The API 400s; the form must not let
 * it get that far.
 *
 * **No bulk approve.** One button per link, no checkbox, no select-all.
 *
 * Every name and address here is invented, as everywhere else in this project's
 * fixtures.
 */

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const LINK_ID = "aaaaaaaa-3333-4a00-9000-000000000001";
const SECOND_ID = "aaaaaaaa-3333-4a00-9000-000000000002";
const PLACE_ID = "bbbbbbbb-3333-4a00-9000-000000000001";
const MEETING_ID = "cccccccc-3333-4a00-9000-000000000001";
const SHA = "f".repeat(64);

const CONTEXT_TEXT =
  "The Commission then took up the conditional use permit. " +
  "The application concerns 1420 North Fictional Avenue, in the north-east quadrant. " +
  "Staff recommended approval with conditions.";

const QUOTE = "The application concerns 1420 North Fictional Avenue, in the north-east quadrant.";

function makeItem(overrides: Partial<PlaceLinkReviewItem> = {}): PlaceLinkReviewItem {
  const start = CONTEXT_TEXT.indexOf(QUOTE);
  return {
    link: {
      id: LINK_ID,
      place_id: PLACE_ID,
      subject_kind: "agenda_item",
      subject_id: "dddddddd-3333-4a00-9000-000000000001",
      relation: "subject_of",
      confidence: "stated",
      status: "held",
      created_at: "2026-08-14T09:00:00.000Z",
      updated_at: "2026-08-14T09:00:00.000Z",
    },
    place: {
      id: PLACE_ID,
      jurisdiction_id: "eeeeeeee-3333-4a00-9000-000000000001",
      jurisdiction_name: "Fictional Springs",
      kind: "address",
      label: "1420 North Fictional Avenue",
      // Deliberately six decimals on the wire, which is what a geocoder hands
      // back. The screen must not print all six for a `block` grade.
      lat: 45.679123,
      lon: -111.038456,
      precision: "block",
      precision_meaning:
        "Interpolated along the street segment from its address range. The block is right; " +
        "the building may be a few doors out. Every US Census match grades here.",
      geocoder: "census",
      geocoded_at: "2026-08-14T08:00:00.000Z",
      external_source: "tiger",
      external_ref: "1234567",
    },
    citation: {
      artifact_sha256: SHA,
      quote: QUOTE,
      quote_offset: 8192,
      source_url: "https://records.example.invalid/agenda.pdf",
      artifact_stored: true,
      viewer_path: `/source/${SHA}?offset=8192&len=${QUOTE.length}`,
      context: {
        text: CONTEXT_TEXT,
        quote_start: start,
        quote_end: start + QUOTE.length,
        window_offset: 7692,
        offset_matches_stored: true,
      },
    },
    subject: {
      kind: "agenda_item",
      id: "dddddddd-3333-4a00-9000-000000000001",
      label: "Conditional use permit — 1420 North Fictional Avenue",
      meeting_id: MEETING_ID,
      is_public: true,
    },
    decision: { approvable: true, blocked_reason: null },
    ...overrides,
  };
}

function queue(data: PlaceLinkReviewItem[]): PlaceLinkQueueResponse {
  return {
    data,
    total: data.length,
    counts: {
      held: data.filter((item) => item.link.status === "held").length,
      approved: data.filter((item) => item.link.status === "approved").length,
      rejected: data.filter((item) => item.link.status === "rejected").length,
    },
  };
}

/** Every queue URL the page asked for, so the filters are checkable. */
function recordQueries(body: PlaceLinkQueueResponse): string[] {
  const asked: string[] = [];
  server.use(
    http.get("/api/admin/place-links/queue", ({ request }) => {
      asked.push(new URL(request.url).search);
      return HttpResponse.json(body);
    }),
  );
  return asked;
}

function install(body: PlaceLinkQueueResponse) {
  server.use(http.get("/api/admin/place-links/queue", () => HttpResponse.json(body)));
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/place-links"]}>
      <AdminPlaceLinksPage />
    </MemoryRouter>,
  );
}

/** Every POST the page made, in order, so "exactly one link" is checkable. */
function recordPosts(): string[] {
  const posted: string[] = [];
  server.use(
    http.post("/api/admin/place-links/:id/:decision", async ({ params, request }) => {
      const body = (await request.json()) as { reason?: unknown };
      posted.push(`${String(params.id)}/${String(params.decision)}:${String(body.reason ?? "")}`);
      return HttpResponse.json(makeItem());
    }),
  );
  return posted;
}

describe("AdminPlaceLinksPage", () => {
  it("shows the three whole-table counts and says they do not follow the filter", async () => {
    install({
      ...queue([makeItem()]),
      counts: { held: 4, approved: 9, rejected: 2 },
    });
    renderPage();

    expect((await screen.findByTestId("count-held")).textContent).toBe("4");
    expect(screen.getByTestId("count-approved").textContent).toBe("9");
    expect(screen.getByTestId("count-rejected").textContent).toBe("2");
    expect(screen.getByText(/Counted over every link, not over the page below/)).toBeInTheDocument();
  });

  it("puts the awaiting-review figure over its own denominator on the stamp", async () => {
    // Rule 6: never a bare number where a denominator exists — "4 of 15", not
    // a lone "4" that could mean 4 of 4 or 4 of four hundred.
    install({
      ...queue([makeItem()]),
      counts: { held: 4, approved: 9, rejected: 2 },
    });
    renderPage();

    expect(await screen.findByText("4 of 15 awaiting review")).toBeInTheDocument();
  });

  it("asks for held links first and passes both filters to the API", async () => {
    const asked = recordQueries(queue([makeItem()]));
    renderPage();

    await waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]).toBe("?status=held");

    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Approved" }));
    await waitFor(() => expect(asked).toHaveLength(2));
    expect(asked[1]).toBe("?status=approved");

    await user.click(screen.getByRole("radio", { name: "Document" }));
    await waitFor(() => expect(asked).toHaveLength(3));
    expect(asked[2]).toBe("?status=approved&subject_kind=document");

    // "All" is the absence of the filter, not a value the API would reject.
    await user.click(screen.getByRole("radio", { name: "All" }));
    await waitFor(() => expect(asked).toHaveLength(4));
    expect(asked[3]).toBe("?subject_kind=document");
  });

  it("shows the quote inside the document with the span marked", async () => {
    install(queue([makeItem()]));
    renderPage();

    const window = await screen.findByTestId(`quote-context-${LINK_ID}`);
    expect(window.textContent).toContain("The Commission then took up the conditional use permit.");
    expect(window.textContent).toContain("Staff recommended approval with conditions.");

    const span = screen.getByTestId(`quote-span-${LINK_ID}`);
    expect(span.tagName).toBe("MARK");
    expect(span.textContent).toBe(QUOTE);
  });

  it("links the source at the query form the server can act on, not a fragment", async () => {
    install(queue([makeItem()]));
    renderPage();

    const link = await screen.findByTestId(`viewer-link-${LINK_ID}`);
    // `?offset=&len=`. A `#offset-` fragment never leaves the browser, so the
    // server would pick the window at character zero and the citation would
    // open the wrong page of a packet with nothing looking broken.
    expect(link.getAttribute("href")).toBe(`/source/${SHA}?offset=8192&len=${QUOTE.length}`);
    expect(link.getAttribute("href")).not.toContain("#");
  });

  it("says when the highlight was located by searching rather than by the stored offset", async () => {
    const item = makeItem();
    const citation = item.citation;
    if (citation === null) throw new Error("fixture must carry a citation");
    const context = citation.context;
    if (context === null) throw new Error("fixture must carry a context");
    install(
      queue([
        {
          ...item,
          citation: { ...citation, context: { ...context, offset_matches_stored: false } },
        },
      ]),
    );
    renderPage();

    expect(
      await screen.findByText(/found by searching the text, not at the offset stored/),
    ).toBeInTheDocument();
    expect(screen.getByTestId(`stored-${LINK_ID}`).textContent).toContain(
      "The stored offset does not match where the quote actually is.",
    );
  });

  it("states the precision in plain words from the API beside the coordinate", async () => {
    install(queue([makeItem()]));
    renderPage();

    const meaning = await screen.findByTestId(`precision-meaning-${LINK_ID}`);
    // The backend's own sentence, not a copy kept on this screen.
    expect(meaning.textContent).toContain("Interpolated along the street segment");
    expect(meaning.textContent).toContain("the building may be a few doors out");

    // The grade is in the same element as the figures, not somewhere below them.
    const coordinate = screen.getByTestId(`coordinate-${LINK_ID}`);
    expect(coordinate.textContent).toContain("Block");
  });

  it("prints no more decimal places than the grade supports", async () => {
    install(queue([makeItem()]));
    renderPage();

    // 45.679123 at `block` — 100 m of uncertainty — is THREE decimals, about
    // 110 m. Four would be 11 m, nine times finer than a TIGER address-range
    // interpolation supports, and the ±100 m written beside it does not undo a
    // number that looks surveyed. The sixth decimal of a latitude is 10 cm.
    const figures = await screen.findByTestId(`coordinate-figures-${LINK_ID}`);
    expect(figures.textContent).toBe("45.679, -111.038");
    expect(figures.textContent).not.toContain("45.679123");
  });

  it("does not place a jurisdiction-grade link, and says why", async () => {
    const item = makeItem();
    install(
      queue([
        {
          ...item,
          place: {
            ...item.place,
            precision: "jurisdiction",
            precision_meaning:
              "The whole jurisdiction, and not a pin at all. Approving this says only that the " +
              "decision is somewhere in this city or county.",
          },
        },
      ]),
    );
    renderPage();

    expect((await screen.findByTestId(`precision-meaning-${LINK_ID}`)).textContent).toContain(
      "not a pin at all",
    );
    expect(screen.getByTestId(`coordinate-${LINK_ID}`).textContent).toContain(
      "carries no position on the ground",
    );
    expect(screen.getByTestId(`coordinate-figures-${LINK_ID}`).textContent).toBe("45.68, -111.04");
  });

  it("refuses to render a precision this build's server did not explain", async () => {
    const item = makeItem();
    install(
      queue([
        {
          ...item,
          place: { ...item.place, precision: "parcel", precision_meaning: null },
        },
      ]),
    );
    renderPage();

    // Not silence and not a guess at which grade was meant.
    expect((await screen.findByTestId(`precision-meaning-${LINK_ID}`)).textContent).toContain(
      "no plain-words meaning for that precision",
    );
    expect(screen.getByTestId(`precision-grade-${LINK_ID}`).textContent).toContain(
      "Precision: parcel",
    );
  });

  it("disables approve on an inferred link, states the API's reason, and keeps reject live", async () => {
    const item = makeItem();
    install(
      queue([
        {
          ...item,
          link: { ...item.link, confidence: "inferred" },
          citation: null,
          decision: {
            approvable: false,
            blocked_reason:
              "this link is inferred, and an inferred link is never public whatever its status. " +
              "Approving it would write a row that says published and shows nothing.",
          },
        },
      ]),
    );
    const posted = recordPosts();
    renderPage();

    const approve = await screen.findByRole("button", { name: "Approve and place" });
    expect(approve).toBeDisabled();
    // On the page, in the API's words, not in a title attribute.
    expect(screen.getByTestId(`blocked-${LINK_ID}`).textContent).toContain(
      "an inferred link is never public whatever its status",
    );
    expect(screen.getByTestId(`inferred-${LINK_ID}`)).toBeInTheDocument();
    expect(screen.getByTestId(`no-citation-${LINK_ID}`).textContent).toContain(
      "This link quotes nothing",
    );

    // Rejecting a lead is a real decision, so that button is live.
    const reject = screen.getByRole("button", { name: "Reject" });
    expect(reject).toBeEnabled();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(`Reason for ${LINK_ID}`), "Not the address in the item.");
    await user.click(reject);

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toBe(`${LINK_ID}/reject:Not the address in the item.`);
  });

  it("says a withheld subject does not block approval rather than looking broken", async () => {
    const item = makeItem();
    install(queue([{ ...item, subject: { ...item.subject, is_public: false } }]));
    renderPage();

    const note = await screen.findByTestId(`subject-publicity-${LINK_ID}`);
    expect(note.textContent).toContain("stays off the map until it is");
    expect(note.textContent).toContain("does not block approval");
    // The approval itself is untouched by it.
    expect(screen.getByRole("button", { name: "Approve and place" })).toBeEnabled();
  });

  it("says an approved pin will show when the subject is already public", async () => {
    install(queue([makeItem()]));
    renderPage();

    expect((await screen.findByTestId(`subject-publicity-${LINK_ID}`)).textContent).toContain(
      "already public",
    );
  });

  it("offers one approve button per link and nothing that acts on a selection", async () => {
    install(
      queue([makeItem(), makeItem({ link: { ...makeItem().link, id: SECOND_ID } })]),
    );
    const posted = recordPosts();
    renderPage();

    const approvals = await screen.findAllByRole("button", { name: "Approve and place" });
    expect(approvals).toHaveLength(2);
    // No select-all and no checkbox column: the two shapes a bulk approve
    // arrives in.
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(
      screen.queryByRole("button", { name: /approve all|approve selected|select all/i }),
    ).toBeNull();

    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText(`Reason for ${LINK_ID}`),
      "The address is in the item text.",
    );
    await user.click(approvals[0]);

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toBe(`${LINK_ID}/approve:The address is in the item text.`);
  });

  it("refuses to send either decision without a reason", async () => {
    install(queue([makeItem()]));
    const posted = recordPosts();
    renderPage();

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Approve and place" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "A decision needs a stated reason.",
    );

    await user.click(screen.getByRole("button", { name: "Reject" }));

    // Nothing left the page. The API would have 400'd both.
    expect(posted).toEqual([]);
  });

  it("repeats the API's refusal verbatim rather than paraphrasing it", async () => {
    install(queue([makeItem()]));
    server.use(
      http.post("/api/admin/place-links/:id/approve", () =>
        HttpResponse.json(
          {
            error:
              "The bytes that link cites are not stored, so a reader could not check it. " +
              "No unsourced claim reaches the public site.",
            statusCode: 409,
          },
          { status: 409 },
        ),
      ),
    );
    renderPage();

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(`Reason for ${LINK_ID}`), "Looks right.");
    await user.click(screen.getByRole("button", { name: "Approve and place" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "No unsourced claim reaches the public site.",
    );
  });

  it("says a link cites nothing a reader could check when the bytes are missing", async () => {
    const item = makeItem();
    const citation = item.citation;
    if (citation === null) throw new Error("fixture must carry a citation");
    install(
      queue([
        {
          ...item,
          citation: { ...citation, artifact_stored: false, source_url: null, context: null },
          decision: {
            approvable: false,
            blocked_reason:
              "the bytes this link cites are not stored, so a reader could not check it",
          },
        },
      ]),
    );
    renderPage();

    expect((await screen.findByTestId(`no-context-${LINK_ID}`)).textContent).toContain(
      "The bytes this link cites are not stored",
    );
    expect(screen.getByRole("button", { name: "Approve and place" })).toBeDisabled();
  });

  it("offers no decision on a link that is already decided, and says where the reason is", async () => {
    const item = makeItem();
    install(
      queue([
        {
          ...item,
          link: { ...item.link, status: "approved", updated_at: "2026-08-15T10:00:00.000Z" },
          decision: { approvable: false, blocked_reason: "this link is approved, not held" },
        },
      ]),
    );
    renderPage();

    expect(await screen.findByText("Approved")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve and place" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    // `place_links` holds no reason column; the log does.
    expect(screen.getByText(/In the correction log/)).toBeInTheDocument();
  });

  it("says what an empty queue means for the filter that produced it", async () => {
    // Held is empty but the table is not — 9 links exist, just not in this
    // status — so this is a filtered absence, not "nothing has been
    // geocoded", and the wording must say so.
    install({ ...queue([]), counts: { held: 0, approved: 9, rejected: 0 } });
    renderPage();

    expect(await screen.findByText(/no place links awaiting review/i)).toBeInTheDocument();
  });

  it("does not report an empty queue when the request failed", async () => {
    server.use(
      http.get("/api/admin/place-links/queue", () => new HttpResponse(null, { status: 500 })),
    );
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The place-link queue could not be loaded.",
    );
    expect(screen.queryByText(/The record shows no/)).toBeNull();
  });

  // ---------------------------------------------------------------------
  // The empty state is most of this page's job today — production is 0
  // held / 0 approved / 0 rejected, and three different reasons a screen can
  // show nothing must not collapse into one sentence.
  // ---------------------------------------------------------------------

  it("says nothing has been geocoded yet when the whole table is empty, not that the record shows none", async () => {
    // The exact shape of production right now: not a filter turning up
    // nothing, the table itself is empty. "The record shows no place links"
    // would claim a fact nobody has checked; this is a pipeline stage that
    // has not produced anything, which is a different and weaker claim.
    install(queue([]));
    renderPage();

    const absence = await screen.findByText(/No sweep has collected place links yet\./);
    expect(absence.textContent).not.toMatch(/^The record shows no/);
    // Says what it would put on the map, per rule 1: answer the question the
    // page exists to answer, even when the answer is "nothing yet".
    expect(absence.textContent).toContain("becomes a pin on the public map");
  });

  it("distinguishes a merely-filtered absence from a table with nothing in it at all", async () => {
    // Same held=0, but 4 approved links exist — the table has real rows, this
    // filter alone is empty. The "not-yet-ingested" wording must not appear.
    install({ ...queue([]), counts: { held: 0, approved: 4, rejected: 0 } });
    renderPage();

    expect(
      await screen.findByText("The record shows no place links awaiting review."),
    ).toBeInTheDocument();
    expect(screen.queryByText("No sweep has collected place links yet.")).toBeNull();
  });
});
