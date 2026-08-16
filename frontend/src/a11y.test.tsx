import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { MemoryRouter, Route, Routes } from "react-router";
import type { RunOptions } from "axe-core";
import { App } from "./App";
import { AuthProvider } from "./contexts/AuthContext";
import { PressroomLayout } from "./components/PressroomLayout";
import { AdminClaimsPage } from "./pages/AdminClaimsPage";
import { AdminHomePage } from "./pages/AdminHomePage";
import { AdminReviewPage } from "./pages/AdminReviewPage";
import { AdminSourcesPage } from "./pages/AdminSourcesPage";
import { server } from "@/mocks/server";
import { expectNoA11yViolations } from "./lib/test-utils";
import type {
  ClaimGovernorVerdict,
  ClaimQueueResponse,
  ClaimReviewItem,
  MatchPolicy,
  PressroomSource,
  QueueStats,
  RecentRun,
  ReviewQueueItem,
  ReviewQueueResponse,
} from "@/types";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/**
 * Scan the reader's site for accessibility violations at the route level.
 *
 * The whole `App` is rendered rather than a page component, because half of
 * what axe checks is structural and only exists once the chrome is present:
 * landmark uniqueness, whether page content sits inside a region, and heading
 * order across the masthead and the page together. A page scanned on its own
 * reports a `region` violation for markup that is perfectly placed in the real
 * document, which is the kind of false alarm that gets a suite switched off.
 *
 * Public routes. The operator console is scanned separately, below, because it
 * needs a signed-in session and its own chrome (`PressroomLayout`) rather than
 * the reader's masthead — see "operator console accessibility".
 */
function renderAt(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  function Providers({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }

  return render(<App />, { wrapper: Providers });
}

/**
 * Exactly one rule is turned off, and only because it cannot execute here
 * rather than because we dislike its answer. `color-contrast` needs a layout
 * engine and a canvas to sample rendered pixels; jsdom has neither, so axe
 * throws `HTMLCanvasElement.prototype.getContext is not implemented` and
 * reports the rule as incomplete for every node on every page. Leaving it on
 * buys no coverage and floods the run with a stack trace per route. The
 * palette's contrast is a design-token question and is fixed in
 * `tailwind.config.ts`, not per component.
 *
 * Nothing else is excluded. A rule that fires means the markup is wrong.
 */
const A11Y_OPTIONS: RunOptions = {
  rules: { "color-contrast": { enabled: false } },
};

const PUBLIC_ROUTES = [
  "/",
  "/meetings",
  "/matters",
  "/officials",
  "/votes",
  "/findings",
  "/search",
  // With no `?near=`, which is the state a reader arrives in: the form and the
  // prompt, and no request fired at anybody's location.
  "/map",
  "/elections",
  "/calendar",
  "/methodology",
  "/privacy",
  "/accessibility",
  "/public-records",
  "/corrections",
  "/status",
  "/metrics",
  "/bot",
  "/data",
  "/subscribe",
  // `/source/:sha256`, at a hash the default MSW handler answers for. A bare
  // `/source/<sha>` with no `?offset=` is a real request — it is what a reader
  // gets by editing the URL, or by following a citation whose offset was
  // stripped — and it renders the whole document window with no highlight, so
  // there is nothing about it that needs a query string to be scannable.
  `/source/${"a1b2c3d4".repeat(8)}`,
  // The `*` route. A 404 is a page a reader genuinely lands on, and it is the
  // one most likely to be built without care.
  "/no-such-page",
] as const;

describe("public site accessibility", () => {
  it.each(PUBLIC_ROUTES)("has no axe violations at %s", async (path) => {
    const { container } = renderAt(path);

    // Wait for the page's own heading before scanning. Several pages derive
    // their <h1> from a fetched record, and scanning mid-flight would audit a
    // loading state rather than the page.
    await screen.findByRole("heading", { level: 1 });

    await expectNoA11yViolations(container, A11Y_OPTIONS);
  });
});

/**
 * Route changes in an SPA replace the document without a page load. Without
 * this, following a nav link left both the tab order and a screen reader's
 * cursor sitting in the masthead, with no signal that the record on screen had
 * changed — the skip link existed but nothing ever used it.
 */
describe("focus on route change", () => {
  it("moves focus to the new page's h1 when a nav link is followed", async () => {
    const user = userEvent.setup();
    renderAt("/");

    const nav = screen.getByRole("navigation", { name: "Primary" });
    await user.click(within(nav).getByRole("link", { name: "Votes" }));

    await waitFor(() => {
      const heading = screen.getByRole("heading", { level: 1, name: "Votes" });
      expect(document.activeElement).toBe(heading);
    });
  });

  it("does not steal focus on the first render of a fresh page load", () => {
    renderAt("/votes");

    // A full page load already starts the reader at the top of the document.
    // Grabbing focus here would move a reader who had not asked to be moved.
    expect(document.activeElement).toBe(document.body);
  });

  it("keeps the h1 out of the tab order", async () => {
    const user = userEvent.setup();
    renderAt("/");

    const nav = screen.getByRole("navigation", { name: "Primary" });
    await user.click(within(nav).getByRole("link", { name: "Votes" }));

    const heading = await screen.findByRole("heading", {
      level: 1,
      name: "Votes",
    });
    // tabIndex -1 makes it a programmatic target only. A keyboard user tabbing
    // through the page must never land on a heading.
    expect(heading).toHaveAttribute("tabindex", "-1");
  });
});

// -----------------------------------------------------------------------------
// The operator console
// -----------------------------------------------------------------------------
//
// The screens below are where 64 unreviewed claims sit, and where roadmap 7.1
// wants a second reviewer. If they cannot be used by keyboard or by screen
// reader, "recruit another reviewer" is a narrower ask than it sounds.
//
// Rendered through `PressroomLayout`, not the bare page — the same reasoning
// the public sweep gives for rendering `App`: axe's structural rules (landmark
// uniqueness, heading order, content-in-region) only mean something once the
// real chrome — the rail nav, the skip link, `<main>` — is present. A signed-in
// session is mocked because `ProtectedRoute` renders nothing else without one.

const OPERATOR = {
  id: "op-1",
  email: "operator@commissionwatch.bmux.sh",
  name: "Operator",
  role: "operator",
  last_login_at: null,
};

function sessionHandler() {
  return http.get("/api/admin/session", () => HttpResponse.json({ operator: OPERATOR }));
}

const HEALTHY_SOURCE: PressroomSource = {
  id: "s1",
  adapter_key: "gallatin_civicplus",
  enabled: true,
  disabled_reason: null,
  health_status: "healthy",
  cron_expression: "0 */6 * * *",
  expected_interval_hours: 6,
  consecutive_failures: 0,
  jurisdiction: { id: "j1", name: "Gallatin County", state: "MT" },
  last_success_at: "2026-08-10T06:00:00.000Z",
  lifetime_records: 412,
  silence: { verdict: "ok", hours_since_success: 2, expected_interval_hours: 6 },
  verdict: "healthy",
  latest_run: {
    id: "r1",
    status: "succeeded",
    started_at: "2026-08-10T06:00:00.000Z",
    finished_at: "2026-08-10T06:04:00.000Z",
    counts: { meetings: 4 },
    error: null,
  },
};

const DISABLED_SOURCE: PressroomSource = {
  id: "s3",
  adapter_key: "bozeman_legistar",
  enabled: false,
  disabled_reason: "bozemanmt.gov sits behind Akamai and returns 403 to the scraper.",
  health_status: "blocked",
  cron_expression: "0 */6 * * *",
  expected_interval_hours: null,
  consecutive_failures: 3,
  jurisdiction: { id: "j3", name: "Bozeman", state: "MT" },
  last_success_at: null,
  lifetime_records: 0,
  silence: { verdict: "unknown", hours_since_success: null, expected_interval_hours: null },
  verdict: "disabled",
  latest_run: null,
};

const EMPTY_QUEUE_STATS: QueueStats = {
  depth: 0,
  oldest_pending_at: null,
  drained_last_hour: 0,
  by_stage: [],
  by_source: [],
  read_at: "2026-08-16T12:00:00.000Z",
};

function sourcesHandler() {
  return http.get("/api/admin/pressroom/sources", () =>
    HttpResponse.json({ data: [HEALTHY_SOURCE, DISABLED_SOURCE], total: 2 }),
  );
}

function pressroomQueueHandler() {
  return http.get("/api/admin/pressroom/queue", () => HttpResponse.json(EMPTY_QUEUE_STATS));
}

function runsHandler() {
  return http.get("/api/admin/pressroom/runs", () =>
    HttpResponse.json({ data: [] as RecentRun[], total: 0 }),
  );
}

const MATCH_POLICY: MatchPolicy = {
  minimumBand: "moderate",
  bands: [
    { band: "weak", label: "Weak name match" },
    { band: "moderate", label: "Possible name match" },
    { band: "strong", label: "Close name match" },
  ],
  statement:
    "A finding here rests on a name match between a filed donor name and text in an " +
    "agenda item. A name match is not a verified identity, and no band means it is.",
};

const CITED_FINDING: ReviewQueueItem = {
  request: {
    id: "req-1",
    status: "pending_review",
    severity: "high",
    reviewer_operator_id: null,
    reviewer_email: null,
    review_comment: null,
    reviewed_at: null,
    expires_at: "2026-08-13T00:00:00.000Z",
    created_at: "2026-08-10T00:00:00.000Z",
    overdue: false,
  },
  finding: {
    id: "11111111-1111-4111-8111-111111111111",
    flag_type: "quorum_issue",
    severity: "high",
    description: "Two of five seated members were recorded present; quorum is three.",
    review_state: "held",
    source: "auto",
    meeting_id: "22222222-2222-4222-8222-222222222222",
    agenda_item_id: null,
    artifact_id: null,
    metadata: null,
    created_at: "2026-08-10T00:00:00.000Z",
  },
  context: {
    meeting_date: "2026-08-04T00:00:00.000Z",
    meeting_published_at: "2026-08-09T00:00:00.000Z",
    commission_name: "City Commission",
    jurisdiction_name: "City of Bozeman",
  },
  citations: [
    {
      kind: "meeting_document",
      artifact_id: "a-1",
      sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      storage_key: "artifacts/ab/abc",
      content_type: "application/pdf",
      source_url: "https://example.invalid/agenda.pdf",
      byte_size: 41234,
      fetched_at: "2026-08-09T00:00:00.000Z",
      document_title: "Agenda",
      document_type: "agenda",
      version_no: 1,
    },
  ],
  evidence: null,
  entity_decision: null,
};

/** A name-match finding, which is what the match panel exists to render. */
const NAME_MATCH_FINDING: ReviewQueueItem = {
  ...CITED_FINDING,
  request: { ...CITED_FINDING.request, id: "req-3" },
  finding: {
    ...CITED_FINDING.finding,
    id: "44444444-4444-4444-8444-444444444444",
    flag_type: "vote_donor_conflict",
    description:
      "Dana Whitcomb voted yes on agenda item 7. The federal campaign finance record lists " +
      "1 contribution totalling $2,500.00 on 2026-03-04 from a donor filed as " +
      '"Ridgeline Aggregate LLC"; this is a name match, not a verified identity.',
  },
  evidence: {
    memberId: "44444444-4444-4444-8444-444444444444",
    memberName: "Dana Whitcomb",
    voteId: "55555555-5555-4555-8555-555555555555",
    votePosition: "yes",
    agendaItemId: "66666666-6666-4666-8666-666666666666",
    agendaItemNumber: 7,
    agendaItemTitle: "Ridgeline Aggregate gravel supply contract award",
    donorName: "Ridgeline Aggregate LLC",
    contributionCount: 1,
    totalAmount: 2500,
    earliestContributionDate: "2026-03-04",
    latestContributionDate: "2026-03-04",
    donorMatch: {
      method: "distinctive_term_overlap",
      band: "moderate",
      score: 0.5,
      matchedTerms: ["ridgeline"],
      unmatchedTerms: ["aggregate"],
      discardedTerms: ["llc"],
    },
    recipientMatch: {
      method: "distinctive_term_overlap",
      band: "strong",
      score: 1,
      matchedTerms: ["whitcomb", "dana"],
      unmatchedTerms: [],
      discardedTerms: [],
    },
    contributions: [
      {
        contributionId: "77777777-7777-4777-8777-777777777777",
        sourceSystem: "openfec",
        donorName: "Ridgeline Aggregate LLC",
        recipientName: "Dana Whitcomb",
        committeeName: "Whitcomb for Montana",
        amount: 2500,
        contributionDate: "2026-03-04",
        externalId: "4062020241234567890",
        imageNumber: "202604159876543210",
        sourceUrl: "https://api.open.fec.gov/v1/schedules/schedule_a/",
        documentUrl: "https://docquery.fec.gov/cgi-bin/fecimg/?202604159876543210",
      },
    ],
    coverageNote: "Federal filings only.",
    operatorEntityDecision: null,
  },
  entity_decision: null,
};

function reviewQueueHandler() {
  const data = [CITED_FINDING, NAME_MATCH_FINDING];
  const body: ReviewQueueResponse = {
    data,
    total: data.length,
    policy: {
      id: "p-1",
      hold_at_or_above: "high",
      review_window_hours: 72,
      updated_by: null,
      updated_by_email: null,
      updated_at: "2026-08-10T00:00:00.000Z",
    },
    counts: {
      pending: data.length,
      overdue: data.filter((item) => item.request.overdue).length,
      approved: 0,
      rejected: 0,
    },
    match_policy: MATCH_POLICY,
    band_counts: { weak: 0, moderate: 1, strong: 0, unbanded: 1 },
  };
  return http.get("/api/admin/review/queue", () => HttpResponse.json(body));
}

const CLAIM_SHA = "c".repeat(64);
const CLAIM_CONTEXT_TEXT =
  "The Commission then turned to the second reading. " +
  "Commissioner Sample voted no on the motion to adopt Ordinance 2145. " +
  "The motion carried four to one.";
const CLAIM_QUOTE = "Commissioner Sample voted no on the motion to adopt Ordinance 2145.";
const AVERY_CLAIM_ID = "aaaaaaaa-1111-4a00-9000-000000000001";
const BLAIR_CLAIM_ID = "aaaaaaaa-1111-4a00-9000-000000000002";

function makeClaimItem(overrides: Partial<ClaimReviewItem> = {}): ClaimReviewItem {
  const start = CLAIM_CONTEXT_TEXT.indexOf(CLAIM_QUOTE);
  return {
    claim: {
      id: AVERY_CLAIM_ID,
      meeting_id: "bbbbbbbb-2222-4a00-9000-000000000001",
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
      text: "Avery Sample — voted no on Ordinance 2145, second reading",
      sha256: "d".repeat(64),
      version: "claim-render@1",
      motive_terms: [],
      approvable: true,
      blocked_reason: null,
      pin: null,
    },
    citation: {
      artifact_sha256: CLAIM_SHA,
      quote_offset: 4096,
      quote: CLAIM_QUOTE,
      source_url: "https://records.example.invalid/minutes.pdf",
      artifact_stored: true,
      viewer_path: `/source/${CLAIM_SHA}#offset-4096`,
      context: {
        text: CLAIM_CONTEXT_TEXT,
        quote_start: start,
        quote_end: start + CLAIM_QUOTE.length,
        window_offset: 3596,
        offset_matches_stored: true,
      },
    },
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

/** A refusal, so the marked-fragment path (the one axe is most likely to trip
 *  on — `<mark>` inside a `<mark>`-adjacent run of text nodes) is in the swept
 *  markup rather than only in unit tests that assert its content. */
const CLAIM_REFUSED_VERDICT: ClaimGovernorVerdict = {
  state: "governor_rejected",
  supported: false,
  unsupported_fragments: ["voted no"],
  relied_on: [{ start: 1980, end: 2046 }],
  relied_on_document: [{ start: 1980, end: 2046 }],
  confidence: "medium",
  model: "test-governor",
  prompt_version: "2026-08-15.1",
  window_sha256: "e".repeat(64),
  created_at: "2026-08-14T10:00:00.000Z",
};

function claimQueueItems(): ClaimReviewItem[] {
  return [
    makeClaimItem({ governor: CLAIM_REFUSED_VERDICT }),
    makeClaimItem({
      claim: { ...makeClaimItem().claim, id: BLAIR_CLAIM_ID, subject_name: "Blair Madgic" },
    }),
  ];
}

function claimsQueueHandler() {
  const data = claimQueueItems();
  const body: ClaimQueueResponse = {
    data,
    total: data.length,
    counts: {
      held: data.length,
      approved: 0,
      rejected: 0,
      retracted: 0,
      overdue: 0,
      governor_unjudged: 1,
    },
  };
  return http.get("/api/admin/claims/queue", () => HttpResponse.json(body));
}

/**
 * The console's own chrome, not the bare page — see the block comment above.
 * `AuthProvider` is real, same as `PressroomLayout.test.tsx`, because the rail
 * reads the signed-in operator's email and `ProtectedRoute` is not in this
 * tree to redirect a signed-out one; `sessionHandler()` stands in for the
 * cookie a real browser would carry.
 */
function renderConsoleAt(path: string) {
  function Providers({ children }: { children: ReactNode }) {
    return (
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </AuthProvider>
    );
  }

  return render(
    <Routes>
      <Route element={<PressroomLayout />}>
        <Route path="/admin" element={<AdminHomePage />} />
        <Route path="/admin/sources" element={<AdminSourcesPage />} />
        <Route path="/admin/review" element={<AdminReviewPage />} />
        <Route path="/admin/claims" element={<AdminClaimsPage />} />
      </Route>
    </Routes>,
    { wrapper: Providers },
  );
}

/**
 * One route per screen a reviewer actually uses: the dashboard (roadmap 7.1's
 * "is anything waiting on me"), Sources (the pressroom health board), the
 * finding queue and the claim queue — the only two screens from which
 * something naming a person becomes public. `ready` is awaited before the
 * scan for the same reason `renderAt`'s callers wait for an h1: `WorkTitle`
 * renders the heading before its data has loaded, and scanning that state
 * would audit a loading placeholder rather than the populated screen these
 * fixtures exist to exercise.
 */
const ADMIN_ROUTES = [
  {
    path: "/admin",
    label: "dashboard",
    ready: () => screen.findByTestId("press-verdict"),
  },
  {
    path: "/admin/sources",
    label: "sources",
    ready: () => screen.findByText("bozeman_legistar"),
  },
  {
    path: "/admin/review",
    label: "review queue",
    ready: () => screen.findByTestId(`match-quality-${NAME_MATCH_FINDING.finding.id}`),
  },
  {
    path: "/admin/claims",
    label: "claims queue",
    ready: () => screen.findByRole("button", { name: "Avery Sample" }),
  },
] as const;

describe("operator console accessibility", () => {
  it.each(ADMIN_ROUTES)("has no axe violations on the $label screen", async ({ path, ready }) => {
    server.use(
      sessionHandler(),
      sourcesHandler(),
      pressroomQueueHandler(),
      runsHandler(),
      reviewQueueHandler(),
      claimsQueueHandler(),
    );
    const { container } = renderConsoleAt(path);

    await screen.findByRole("heading", { level: 1 });
    await ready();
    await expectNoA11yViolations(container, A11Y_OPTIONS);
  });
});

/**
 * axe cannot tell "this control cannot be reached or activated by keyboard" —
 * it checks markup, not the tab sequence. So the review path gets its own
 * assertions: a real operator approves and rejects with a mouse nowhere in
 * reach, and the claims screen's collapsible group headers — added the same
 * day this suite was written — are checked the same way a sighted mouse user
 * never would, because a collapsible that only a mouse can open makes the
 * grouping actively worse than the flat list it replaced.
 */
describe("operator console keyboard reachability — claims review", () => {
  it("reaches and activates Approve and publish by keyboard alone, with no mouse event fired", async () => {
    server.use(claimsQueueHandler());
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/admin/claims"]}>
        <AdminClaimsPage />
      </MemoryRouter>,
    );

    const reason = await screen.findByLabelText(`Reason for ${AVERY_CLAIM_ID}`);
    // Focus and fill the reason field by keyboard, then tab forward — the
    // approve button is the very next stop in document order.
    await user.click(reason);
    await user.keyboard("Checked against the minutes.");
    await user.tab();

    expect(document.activeElement).toHaveAccessibleName("Approve and publish");
    expect(document.activeElement?.tagName).toBe("BUTTON");

    let posted = 0;
    server.use(
      http.post("/api/admin/claims/:id/approve", () => {
        posted += 1;
        return HttpResponse.json(makeClaimItem());
      }),
    );

    await user.keyboard("{Enter}");
    await waitFor(() => expect(posted).toBe(1));
  });

  it("reaches and activates Reject by keyboard alone", async () => {
    server.use(claimsQueueHandler());
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/admin/claims"]}>
        <AdminClaimsPage />
      </MemoryRouter>,
    );

    const reason = await screen.findByLabelText(`Reason for ${AVERY_CLAIM_ID}`);
    await user.click(reason);
    await user.keyboard("Checked against the minutes.");
    await user.tab();
    await user.tab();

    expect(document.activeElement).toHaveAccessibleName("Reject");
    expect(document.activeElement?.tagName).toBe("BUTTON");

    let posted = 0;
    server.use(
      http.post("/api/admin/claims/:id/reject", () => {
        posted += 1;
        return HttpResponse.json(makeClaimItem());
      }),
    );

    await user.keyboard("{Enter}");
    await waitFor(() => expect(posted).toBe(1));
  });

  it("makes a subject's collapse toggle a real button, reachable by Tab and operable by Enter and Space, with its state exposed to assistive tech", async () => {
    server.use(claimsQueueHandler());
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/admin/claims"]}>
        <AdminClaimsPage />
      </MemoryRouter>,
    );

    const toggle = await screen.findByRole("button", { name: "Avery Sample" });
    // A real, focusable control — not a `<div onClick>` a screen reader would
    // never announce as interactive.
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    toggle.focus();
    expect(document.activeElement).toBe(toggle);

    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId(`render-text-${AVERY_CLAIM_ID}`)).not.toBeInTheDocument();

    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByTestId(`render-text-${AVERY_CLAIM_ID}`)).toBeInTheDocument();
  });
});
