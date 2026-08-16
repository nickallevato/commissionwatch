import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { AdminClaimsPage } from "./AdminClaimsPage";
import { server } from "@/mocks/server";
import type { ClaimGovernorVerdict, ClaimQueueResponse, ClaimReviewItem } from "@/types";

/**
 * `/admin/claims` — the screen from which a sentence naming a living person
 * becomes public, verbatim.
 *
 * What this suite guards is not layout. It is the five things that make an
 * approval on this screen mean something:
 *
 * **The quote is visible in the document, with the span marked.** An operator
 * approving a sentence they cannot see in situ is rubber-stamping. If the
 * highlight ever disappears the screen still looks complete, which is exactly
 * why it needs an assertion rather than an eye.
 *
 * **The sentence shown is the API's `render.text`.** Approval pins those bytes.
 * The fixture's triple would render a *different* string through the backend's
 * own template, so a console that assembled its own version fails the second
 * test below rather than shipping and pinning something nobody read.
 *
 * **No bulk approve.** One button per claim, no checkbox, no select-all. A
 * screen that approves forty claims in one click publishes forty unread
 * sentences about named people, and this is the screen where someone would
 * build it.
 *
 * **A blocked approval says why, on the page.** The API refuses either way; a
 * disabled button whose reason is a hover away is a disabled button with no
 * reason.
 *
 * **No decision without a stated reason.** The API 400s, and the form must not
 * let it get that far — a button that reliably produces an error it could have
 * prevented trains an operator to ignore errors.
 *
 * **The governor annotates and decides nothing.** A second model's verdict may
 * change what the operator reads and the order they read it in. It may not
 * change what they are able to do, and it may not make a claim disappear. The
 * block of tests at the end of this file is that constraint.
 *
 * Every name here is invented, as everywhere else in this project's fixtures.
 */

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const CLAIM_ID = "aaaaaaaa-1111-4a00-9000-000000000001";
const SECOND_ID = "aaaaaaaa-1111-4a00-9000-000000000002";
const THIRD_ID = "aaaaaaaa-1111-4a00-9000-000000000003";
const MEETING_ID = "bbbbbbbb-2222-4a00-9000-000000000001";
const SHA = "c".repeat(64);

const CONTEXT_TEXT =
  "The Commission then turned to the second reading. " +
  "Commissioner Sample voted no on the motion to adopt Ordinance 2145. " +
  "The motion carried four to one.";

const QUOTE = "Commissioner Sample voted no on the motion to adopt Ordinance 2145.";

function makeItem(overrides: Partial<ClaimReviewItem> = {}): ClaimReviewItem {
  const start = CONTEXT_TEXT.indexOf(QUOTE);
  return {
    claim: {
      id: CLAIM_ID,
      meeting_id: MEETING_ID,
      subject_name: "Avery Sample",
      member_id: null,
      action: "voted_no",
      matter: "Ordinance 2145",
      status: "held",
      model: "test-extractor",
      prompt_version: "claim-extract@2",
      reviewed_by: null,
      review_reason: null,
      reviewed_at: null,
      approved_by: null,
      approved_at: null,
      rendered_text: null,
      render_sha256: null,
      render_version: null,
      retracted_at: null,
      retracted_reason: null,
      created_at: "2026-08-12T09:00:00.000Z",
      overdue: false,
    },
    render: {
      // Not `{subject} — {label} on {matter}` over the triple above: the
      // suffix is what a page rebuilding the sentence would lose.
      text: "Avery Sample — voted no on Ordinance 2145, second reading",
      sha256: "d".repeat(64),
      version: "claim-render@1",
      motive_terms: [],
      approvable: true,
      blocked_reason: null,
      pin: null,
    },
    citation: {
      artifact_sha256: SHA,
      quote_offset: 4096,
      quote: QUOTE,
      source_url: "https://records.example.invalid/minutes.pdf",
      artifact_stored: true,
      viewer_path: `/source/${SHA}#offset-4096`,
      context: {
        text: CONTEXT_TEXT,
        quote_start: start,
        quote_end: start + QUOTE.length,
        window_offset: 3596,
        offset_matches_stored: true,
      },
    },
    // Not checked, which is the honest default: most claims in this queue have
    // no verdict, and a fixture that gave every claim one would let the third
    // state go untested by accident.
    governor: null,
    context: {
      meeting_date: "2026-03-12",
      meeting_published_at: "2026-03-14T00:00:00.000Z",
      commission_name: "Example Commission on Public Works",
      jurisdiction_name: "Fictional Springs",
    },
    ...overrides,
  };
}

function queue(data: ClaimReviewItem[]): ClaimQueueResponse {
  return {
    data,
    total: data.length,
    counts: {
      held: data.filter((item) => item.claim.status === "held").length,
      approved: data.filter((item) => item.claim.status === "approved").length,
      rejected: data.filter((item) => item.claim.status === "rejected").length,
      retracted: data.filter((item) => item.claim.retracted_at !== null).length,
      overdue: data.filter((item) => item.claim.overdue).length,
      governor_unjudged: data.filter(
        (item) => item.claim.status === "held" && item.governor === null,
      ).length,
    },
  };
}

/** A verdict, in the shape `services/governor/store.ts` serves one. */
function verdict(overrides: Partial<ClaimGovernorVerdict> = {}): ClaimGovernorVerdict {
  return {
    state: "supported",
    supported: true,
    unsupported_fragments: [],
    relied_on: [{ start: 1980, end: 2046 }],
    // Document coordinates. The backend re-bases `relied_on` by the governor
    // window's own start so any window can map them; `relied_on` alone indexes
    // a window nothing serves.
    relied_on_document: [{ start: 1980, end: 2046 }],
    confidence: "high",
    model: "test-governor",
    prompt_version: "2026-08-15.1",
    window_sha256: "e".repeat(64),
    created_at: "2026-08-14T10:00:00.000Z",
    ...overrides,
  };
}

const REFUSED = verdict({
  state: "governor_rejected",
  supported: false,
  // The wording of the quote, which is what the prompt asks for and what can be
  // marked in place.
  unsupported_fragments: ["voted no"],
  confidence: "medium",
});

function install(body: ClaimQueueResponse) {
  server.use(http.get("/api/admin/claims/queue", () => HttpResponse.json(body)));
}

/**
 * A request that failed leaves the page with no listing and an empty array, and
 * those are not the same fact. This is asserted rather than assumed because the
 * empty-queue copy is the strongest claim the screen can make — "the record
 * shows nothing awaiting review" — and it was, for a while, what a 500 produced.
 */
function installFailure(status = 500) {
  server.use(
    http.get("/api/admin/claims/queue", () => new HttpResponse(null, { status })),
  );
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/claims"]}>
      <AdminClaimsPage />
    </MemoryRouter>,
  );
}

/** Every POST the page made, in order, so "exactly one claim" is checkable. */
function recordPosts(): string[] {
  const posted: string[] = [];
  server.use(
    http.post("/api/admin/claims/:id/:decision", async ({ params, request }) => {
      const body = (await request.json()) as { reason?: unknown };
      posted.push(`${String(params.id)}/${String(params.decision)}:${String(body.reason ?? "")}`);
      return HttpResponse.json(makeItem());
    }),
  );
  return posted;
}

describe("AdminClaimsPage", () => {
  it("shows the quote inside the document with the span marked", async () => {
    install(queue([makeItem()]));
    renderPage();

    const window = await screen.findByTestId(`quote-context-${CLAIM_ID}`);
    // The window, not just the quote: the surrounding sentences are the whole
    // reason this element exists.
    expect(window.textContent).toContain("The Commission then turned to the second reading.");
    expect(window.textContent).toContain("The motion carried four to one.");

    const span = screen.getByTestId(`quote-span-${CLAIM_ID}`);
    expect(span.tagName).toBe("MARK");
    expect(span.textContent).toBe(QUOTE);
  });

  it("says when the highlight was located by searching rather than by the stored offset", async () => {
    const item = makeItem();
    const context = item.citation.context;
    if (context === null) throw new Error("fixture must carry a context");
    install(queue([{ ...item, citation: { ...item.citation, context: { ...context, offset_matches_stored: false } } }]));
    renderPage();

    expect(
      await screen.findByText(/found by searching the text, not at the offset stored/),
    ).toBeInTheDocument();
  });

  it("shows the exact sentence the API would publish, not one rebuilt from the claim", async () => {
    install(queue([makeItem()]));
    renderPage();

    const sentence = await screen.findByTestId(`render-text-${CLAIM_ID}`);
    // Exact. "Avery Sample — voted no on Ordinance 2145" is what this page
    // would produce from `subject_name`, `action` and `matter`, and it is a
    // prefix of the approved string — so only an equality check fails a page
    // that assembled its own.
    expect(sentence.textContent).toBe(
      "Avery Sample — voted no on Ordinance 2145, second reading",
    );
  });

  it("disables approve and states the reason when the claim is not approvable", async () => {
    install(
      queue([
        makeItem({
          render: {
            text: "Avery Sample — voted no on Ordinance 2145, second reading",
            sha256: "d".repeat(64),
            version: "claim-render@1",
            motive_terms: [],
            approvable: false,
            blocked_reason:
              "the bytes this claim cites are not stored, so a reader could not check it",
            pin: null,
          },
        }),
      ]),
    );
    renderPage();

    const approve = await screen.findByRole("button", { name: "Approve and publish" });
    expect(approve).toBeDisabled();
    // On the page, not in a title attribute.
    expect(screen.getByTestId(`blocked-${CLAIM_ID}`).textContent).toContain(
      "the bytes this claim cites are not stored, so a reader could not check it",
    );
  });

  it("names the motive terms that block approval", async () => {
    install(
      queue([
        makeItem({
          render: {
            text: "Avery Sample — voted no on Ordinance 2145 because of the developer",
            sha256: "d".repeat(64),
            version: "claim-render@1",
            motive_terms: ["because"],
            approvable: false,
            blocked_reason: "the sentence asserts motive. Remove: because",
            pin: null,
          },
        }),
      ]),
    );
    renderPage();

    expect((await screen.findByTestId(`motive-${CLAIM_ID}`)).textContent).toContain("because");
  });

  it("explains an approved claim whose pin no longer holds", async () => {
    install(
      queue([
        makeItem({
          claim: { ...makeItem().claim, status: "approved", approved_at: "2026-08-13T00:00:00.000Z" },
          render: {
            text: "Avery Sample — voted no on Ordinance 2145, second reading",
            sha256: "d".repeat(64),
            version: "claim-render@1",
            motive_terms: [],
            approvable: false,
            blocked_reason: "this claim is approved, not held",
            pin: {
              state: "awaiting_re_review",
              reason: "the sentence this build renders is not the sentence that was approved",
            },
          },
        }),
      ]),
    );
    renderPage();

    const banner = await screen.findByTestId(`awaiting-re-review-${CLAIM_ID}`);
    expect(banner.textContent).toContain("is not being published");
    expect(banner.textContent).toContain(
      "the sentence this build renders is not the sentence that was approved",
    );
  });

  it("offers one approve button per claim and nothing that acts on a selection", async () => {
    install(
      queue([
        makeItem(),
        makeItem({ claim: { ...makeItem().claim, id: SECOND_ID } }),
      ]),
    );
    const posted = recordPosts();
    renderPage();

    const approvals = await screen.findAllByRole("button", { name: "Approve and publish" });
    expect(approvals).toHaveLength(2);
    // No select-all and no checkbox column: the two shapes a bulk approve
    // arrives in.
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(
      screen.queryByRole("button", { name: /approve all|approve selected|select all/i }),
    ).toBeNull();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(`Reason for ${CLAIM_ID}`), "Checked against the minutes.");
    await user.click(approvals[0]);

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toBe(`${CLAIM_ID}/approve:Checked against the minutes.`);
  });

  it("refuses to send an approval, a rejection or a retraction without a reason", async () => {
    install(
      queue([
        makeItem(),
        makeItem({
          claim: {
            ...makeItem().claim,
            id: SECOND_ID,
            status: "approved",
            approved_at: "2026-08-13T00:00:00.000Z",
          },
          render: { ...makeItem().render, approvable: false, blocked_reason: "this claim is approved, not held" },
        }),
      ]),
    );
    const posted = recordPosts();
    renderPage();

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Approve and publish" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "A decision needs a stated reason.",
    );

    await user.click(screen.getByRole("button", { name: "Reject" }));
    await user.click(screen.getByRole("button", { name: "Withdraw" }));

    // Nothing left the page. The API would have 400'd all three.
    expect(posted).toEqual([]);
  });

  it("sends a withdrawal with its reason for a published claim", async () => {
    install(
      queue([
        makeItem({
          claim: {
            ...makeItem().claim,
            status: "approved",
            approved_at: "2026-08-13T00:00:00.000Z",
            rendered_text: "Avery Sample — voted no on Ordinance 2145, second reading",
          },
          render: { ...makeItem().render, approvable: false, blocked_reason: "this claim is approved, not held" },
        }),
      ]),
    );
    const posted = recordPosts();
    renderPage();

    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText(`Reason for ${CLAIM_ID}`),
      "The minutes were reissued and the vote is recorded differently.",
    );
    await user.click(screen.getByRole("button", { name: "Withdraw" }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toBe(
      `${CLAIM_ID}/retract:The minutes were reissued and the vote is recorded differently.`,
    );
  });

  it("repeats the API's refusal verbatim rather than paraphrasing it", async () => {
    install(queue([makeItem()]));
    server.use(
      http.post("/api/admin/claims/:id/approve", () =>
        HttpResponse.json(
          {
            error:
              "The bytes that claim cites are not stored, so a reader could not check it. " +
              "No unsourced claim reaches the public site.",
            statusCode: 409,
          },
          { status: 409 },
        ),
      ),
    );
    renderPage();

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(`Reason for ${CLAIM_ID}`), "Looks right.");
    await user.click(screen.getByRole("button", { name: "Approve and publish" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "No unsourced claim reaches the public site.",
    );
  });

  it("says a claim cites nothing a reader could check when the bytes are missing", async () => {
    install(
      queue([
        makeItem({
          citation: {
            ...makeItem().citation,
            artifact_stored: false,
            context: null,
          },
          render: {
            ...makeItem().render,
            approvable: false,
            blocked_reason:
              "the bytes this claim cites are not stored, so a reader could not check it",
          },
        }),
      ]),
    );
    renderPage();

    expect((await screen.findByTestId(`no-context-${CLAIM_ID}`)).textContent).toContain(
      "The bytes this claim cites are not stored",
    );
  });

  it("states what an empty queue means instead of showing nothing", async () => {
    install(queue([]));
    renderPage();

    expect(
      await screen.findByText("The record shows no claims awaiting review."),
    ).toBeInTheDocument();
  });

  /**
   * The governor's half of this screen.
   *
   * It exists because `verify.ts` cannot decide which of two names in one
   * sentence a verb attaches to, and it must never grow past that: it annotates
   * and it reorders, and a person still presses the button. Every test here is
   * one of the four ways this feature turns into an auto-discarder — a verdict
   * that gates the button, a refusal that hides the claim, a "not checked" that
   * reads as a pass, or a verdict nobody can trace back to a model.
   */
  it("marks the fragments a refusal named, inside the quote", async () => {
    install(queue([makeItem({ governor: REFUSED })]));
    renderPage();

    const marked = await screen.findByTestId(`governor-fragments-${CLAIM_ID}`);
    // The whole quote, not just the objection: an operator reading a bare
    // fragment cannot tell what it was a fragment of.
    expect(marked.textContent).toBe(QUOTE);

    const fragment = screen.getByTestId(`governor-fragment-${CLAIM_ID}`);
    expect(fragment.tagName).toBe("MARK");
    expect(fragment.textContent).toBe("voted no");
  });

  it("shows a fragment that is not wording of the quote rather than dropping it", async () => {
    // The judge is asked to name "the person, the action, or the matter" in a
    // few words, so this is a shape the backend really produces. Silently
    // discarding it would leave the operator an unmarked quote to read as an
    // unchallenged one.
    install(
      queue([
        makeItem({ governor: verdict({ ...REFUSED, unsupported_fragments: ["the action"] }) }),
      ]),
    );
    renderPage();

    expect((await screen.findByTestId(`governor-unlocated-${CLAIM_ID}`)).textContent).toContain(
      "the action",
    );
    expect(screen.queryByTestId(`governor-fragment-${CLAIM_ID}`)).toBeNull();
  });

  it("says a claim was not checked rather than leaving a blank that reads as a pass", async () => {
    install(queue([makeItem({ governor: null })]));
    renderPage();

    const panel = await screen.findByTestId(`governor-${CLAIM_ID}`);
    expect(panel.dataset.governorState).toBe("unchecked");
    expect(panel.textContent).toContain("not checked");
    expect(panel.textContent).toContain("That is not a pass");
    // Distinguishable from both other states, not merely worded differently.
    expect(panel.textContent).not.toContain("attribution supported");
    expect(panel.textContent).not.toContain("attribution not supported");
    // Nothing to mark, because there is no verdict to mark anything from.
    expect(screen.queryByTestId(`governor-fragments-${CLAIM_ID}`)).toBeNull();
    expect(screen.queryByTestId(`governor-provenance-${CLAIM_ID}`)).toBeNull();
  });

  it("labels a supported claim as one model's reading and not as a clearance", async () => {
    install(queue([makeItem({ governor: verdict() })]));
    renderPage();

    const panel = await screen.findByTestId(`governor-${CLAIM_ID}`);
    expect(panel.dataset.governorState).toBe("supported");
    expect(panel.textContent).toContain("attribution supported");
    expect(screen.queryByTestId(`governor-fragment-${CLAIM_ID}`)).toBeNull();
  });

  it("takes the approve button's state from render.approvable and never from the verdict", async () => {
    // The same `render.approvable` across all three verdict states. If any one
    // of these buttons disagrees with the other two, the governor has acquired
    // a power the design says it does not have — and the failure mode is a
    // claim a model refused that a person is no longer able to approve.
    const held = makeItem().claim;
    install(
      queue([
        makeItem({ governor: null }),
        makeItem({ claim: { ...held, id: SECOND_ID }, governor: verdict() }),
        makeItem({ claim: { ...held, id: THIRD_ID }, governor: REFUSED }),
      ]),
    );
    const first = renderPage();

    const approvals = await screen.findAllByRole("button", { name: "Approve and publish" });
    expect(approvals).toHaveLength(3);
    for (const button of approvals) expect(button).toBeEnabled();
    first.unmount();

    // And the other way: a claim the governor supported is still refused when
    // the backend says it is not approvable, so the button is not reading the
    // verdict in either direction.
    install(
      queue([
        makeItem({
          governor: verdict(),
          render: {
            ...makeItem().render,
            approvable: false,
            blocked_reason:
              "the bytes this claim cites are not stored, so a reader could not check it",
          },
        }),
      ]),
    );
    renderPage();

    expect(await screen.findByRole("button", { name: "Approve and publish" })).toBeDisabled();
  });

  it("leaves a refused claim fully readable, with its controls", async () => {
    install(queue([makeItem({ governor: REFUSED })]));
    renderPage();

    // Sorted last by the backend, not hidden and not collapsed here. Everything
    // an unjudged claim shows, this shows too.
    expect((await screen.findByTestId(`render-text-${CLAIM_ID}`)).textContent).toBe(
      "Avery Sample — voted no on Ordinance 2145, second reading",
    );
    expect(screen.getByTestId(`quote-context-${CLAIM_ID}`).textContent).toContain(
      "The motion carried four to one.",
    );
    expect(screen.getByRole("button", { name: "Approve and publish" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
    expect(screen.getByLabelText(`Reason for ${CLAIM_ID}`)).toBeInTheDocument();
  });

  it("names the model and prompt version behind a verdict", async () => {
    install(queue([makeItem({ governor: verdict() })]));
    renderPage();

    // A verdict whose model nobody recorded is a verdict nobody can re-examine
    // when that model turns out to be bad.
    const provenance = await screen.findByTestId(`governor-provenance-${CLAIM_ID}`);
    expect(provenance.textContent).toContain("test-governor");
    expect(provenance.textContent).toContain("2026-08-15.1");
    expect(provenance.textContent).toContain("high confidence");
  });

  it("counts the claims the governor has never judged", async () => {
    install(
      queue([
        makeItem({ governor: null }),
        makeItem({ claim: { ...makeItem().claim, id: SECOND_ID }, governor: verdict() }),
      ]),
    );
    renderPage();

    // One of the two. A backlog that is not on the counts row is a backlog
    // indistinguishable from a quiet week.
    expect((await screen.findByTestId("governor-unjudged-count")).textContent).toBe("1");
  });

  it("reports a queue it could not load as a failure of ours", async () => {
    server.use(
      http.get("/api/admin/claims/queue", () =>
        HttpResponse.json({ error: "Authentication required", statusCode: 401 }, { status: 401 }),
      ),
    );
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The claims queue could not be loaded.",
    );
  });

  // -------------------------------------------------------------------------
  // Grouping — 64 held claims across five subjects in production is a wall as
  // a flat list. Grouped by `claim.subject_name`, it is five decisions.
  // -------------------------------------------------------------------------

  it("groups claims by subject, each with its own count", async () => {
    install(
      queue([
        makeItem(),
        makeItem({ claim: { ...makeItem().claim, id: SECOND_ID, subject_name: "Blair Madgic" } }),
        makeItem({ claim: { ...makeItem().claim, id: THIRD_ID } }),
      ]),
    );
    renderPage();

    const averyGroup = await screen.findByTestId("group-avery-sample");
    const blairGroup = await screen.findByTestId("group-blair-madgic");
    // Two of Avery Sample's claims land in one group, not two.
    expect(screen.getByTestId("group-count-avery-sample").textContent).toContain("2");
    expect(screen.getByTestId("group-count-blair-madgic").textContent).toContain("1");
    expect(averyGroup.textContent).toContain("Avery Sample");
    expect(blairGroup.textContent).toContain("Blair Madgic");
    // Both subjects' claims are visible — grouping re-shapes the page, it
    // does not hide anyone's claim.
    expect(screen.getAllByRole("button", { name: "Approve and publish" })).toHaveLength(3);
  });

  it("counts a group's own overdue claims in the accent colour, not just the page total", async () => {
    install(
      queue([
        makeItem({ claim: { ...makeItem().claim, overdue: true } }),
        makeItem({
          claim: { ...makeItem().claim, id: SECOND_ID, subject_name: "Blair Madgic", overdue: false },
        }),
      ]),
    );
    renderPage();

    const averyCount = await screen.findByTestId("group-count-avery-sample");
    expect(averyCount.textContent).toContain("1 overdue");
    const blairCount = screen.getByTestId("group-count-blair-madgic");
    expect(blairCount.textContent).not.toContain("overdue");
  });

  it("collapses a group to hide its claims, and expands it back", async () => {
    install(queue([makeItem()]));
    renderPage();

    await screen.findByTestId(`render-text-${CLAIM_ID}`);
    const toggle = screen.getByRole("button", { name: "Avery Sample" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    const user = userEvent.setup();
    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The claim itself is gone from the DOM, not merely visually hidden —
    // this is what makes a subject "quiet" while another is worked through.
    expect(screen.queryByTestId(`render-text-${CLAIM_ID}`)).toBeNull();
    // The count stays on the page even while collapsed: a quieted group is
    // still a checkable fact, not a blank.
    expect(screen.getByTestId("group-count-avery-sample")).toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByTestId(`render-text-${CLAIM_ID}`)).toBeInTheDocument();
  });

  it("reports the number of subjects waiting, on the page's own stamp", async () => {
    install(
      queue([
        makeItem(),
        makeItem({ claim: { ...makeItem().claim, id: SECOND_ID, subject_name: "Blair Madgic" } }),
      ]),
    );
    renderPage();

    await screen.findByTestId(`render-text-${CLAIM_ID}`);
    expect(screen.getByText(/2 subjects/)).toBeInTheDocument();
  });
});

describe("AdminClaimsPage when the queue cannot be read", () => {
  it("says the request failed rather than that nothing is awaiting review", async () => {
    installFailure();
    renderPage();

    expect(
      await screen.findByText(/could not be loaded\. That is a failure on our side/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^The record shows no /)).not.toBeInTheDocument();
  });
});
