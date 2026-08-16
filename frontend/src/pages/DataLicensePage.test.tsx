import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { renderWithProviders, screen } from "../lib/test-utils";
import { DataLicensePage } from "./DataLicensePage";
import { server } from "@/mocks/server";
import type { DataManifestDataset } from "@/types";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** A manifest with two datasets: one that carries provenance and one that cannot. */
function serveManifest(datasets: DataManifestDataset[]) {
  server.use(
    http.get("/api/data", () =>
      HttpResponse.json({
        generated_at: "2026-08-10T00:00:00.000Z",
        schema_migration: "039_create_record_disputes.ts",
        attribution: "CommissionWatch — commissionwatch.bmux.sh",
        license: {
          dataset: {
            name: "CC BY 4.0",
            url: "https://creativecommons.org/licenses/by/4.0/",
            covers: "The compiled dataset.",
            attribution:
              "Data from CommissionWatch — commissionwatch.bmux.sh, CC BY 4.0.",
          },
          code: { name: "MIT", url: null, covers: "The repository." },
          documents: {
            name: "No licence asserted",
            url: null,
            covers: "The government documents.",
          },
        },
        republication_request: "Republish a finding's corrections status.",
        publication_rule: "Only records an operator has published appear here.",
        datasets,
      }),
    ),
  );
}

/**
 * The archive index as the backend serves it with `dated_export_archive` on.
 * Off, the route 404s — that is the default handler, and the page reads the
 * 404 rather than being told separately that a feature is off.
 */
function serveArchive(answerableFrom: string | null) {
  server.use(
    http.get("/api/data/archive", () =>
      HttpResponse.json({
        answerable_from: answerableFrom,
        path: "/api/data/archive/{date}/{dataset}.{json|csv}",
      }),
    ),
  );
}

const MEETINGS: DataManifestDataset = {
  name: "meetings",
  description: "Published meetings.",
  provenance: "`source_artifact_sha256` is the newest stored agenda.",
  columns: ["id", "date", "source_artifact_sha256"],
  row_count: 7,
  json_url: "/api/data/meetings.json",
  csv_url: "/api/data/meetings.csv",
};

const MEMBERS: DataManifestDataset = {
  name: "members",
  description: "Elected and appointed officials.",
  provenance: null,
  columns: ["id", "name"],
  row_count: 3,
  json_url: "/api/data/members.json",
  csv_url: "/api/data/members.csv",
};

/** Paths this app actually routes — see the note in `MethodologyPage.test.tsx`. */
const ROUTED_PATHS = [
  "/",
  "/meetings",
  "/members",
  "/votes",
  "/anomalies",
  "/methodology",
  "/data",
  "/data-license",
  "/calendar",
  "/status",
];

describe("DataLicensePage", () => {
  it("renders as the open data page", () => {
    renderWithProviders(<DataLicensePage />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Open data" }),
    ).toBeInTheDocument();
  });

  it("licenses the three layers separately", () => {
    renderWithProviders(<DataLicensePage />);
    expect(screen.getByText("The compiled dataset")).toBeInTheDocument();
    expect(screen.getByText("CC BY 4.0")).toBeInTheDocument();
    expect(screen.getByText("The code")).toBeInTheDocument();
    expect(screen.getByText("MIT")).toBeInTheDocument();
    expect(screen.getByText("The government documents")).toBeInTheDocument();
    expect(screen.getByText("No license asserted")).toBeInTheDocument();
  });

  it("gives an attribution line a reuser can copy", () => {
    renderWithProviders(<DataLicensePage />);
    expect(
      screen.getByText(/Data from CommissionWatch — commissionwatch\.bmux\.sh/),
    ).toBeInTheDocument();
  });

  it("lists what is withheld with a reason for each", () => {
    const { container } = renderWithProviders(<DataLicensePage />);
    const heading = screen.getByRole("heading", {
      name: "What is withheld, and why",
    });
    const section = heading.closest("section");
    expect(section).not.toBeNull();
    const rows = section!.querySelectorAll("tbody tr");
    expect(rows.length).toBeGreaterThanOrEqual(8);
    for (const row of rows) {
      expect(row.querySelectorAll("td")).toHaveLength(2);
    }
    expect(container.textContent).toMatch(/Subscriber email addresses/);
  });

  it("marks the corrections request as a request, not a license term", () => {
    renderWithProviders(<DataLicensePage />);
    expect(screen.getByText("A request, not a term")).toBeInTheDocument();
  });

  it("links to the canonical license texts", () => {
    const { container } = renderWithProviders(<DataLicensePage />);
    expect(
      container.querySelector(
        'a[href="https://creativecommons.org/licenses/by/4.0/"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        'a[href="https://github.com/nickallevato/commissionwatch"]',
      ),
    ).not.toBeNull();
  });

  it("links only to paths the app routes", () => {
    const { container } = renderWithProviders(<DataLicensePage />);
    const internal = [...container.querySelectorAll("a[href]")]
      .map((node) => node.getAttribute("href") ?? "")
      // `/api/...` links are the export itself — served by the backend, not by
      // the SPA router. They are checked by the backend's own suite, which is
      // where a dataset that stops being served would actually be caught.
      .filter((href) => href.startsWith("/") && !href.startsWith("/api/"));

    expect(internal.length).toBeGreaterThan(0);
    for (const href of internal) {
      expect(ROUTED_PATHS, `${href} is not a routed path`).toContain(href);
    }
  });

  /* --------------------------------------------------------- the export */

  it("lists the exported tables from the API rather than from a hand-kept list", async () => {
    serveManifest([MEETINGS, MEMBERS]);
    renderWithProviders(<DataLicensePage />);

    await waitFor(() =>
      expect(screen.getByText("meetings")).toBeInTheDocument(),
    );
    expect(screen.getByText("members")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "CSV" })).toHaveLength(2);
    expect(
      screen.getAllByRole("link", { name: "JSON" })[0],
    ).toHaveAttribute("href", "/api/data/meetings.json");
  });

  it("says a table has no source document rather than leaving the cell blank", async () => {
    serveManifest([MEMBERS]);
    const { container } = renderWithProviders(<DataLicensePage />);

    await waitFor(() =>
      expect(screen.getByText("members")).toBeInTheDocument(),
    );
    // A blank provenance cell reads as a lost source. The truth is that the
    // schema records none for a roster, and the page has to say which.
    expect(container.textContent).toMatch(
      /No source document is recorded for these rows/,
    );
  });

  it("states that only published records are exported", async () => {
    serveManifest([MEETINGS]);
    const { container } = renderWithProviders(<DataLicensePage />);
    await waitFor(() =>
      expect(screen.getByText("meetings")).toBeInTheDocument(),
    );
    expect(container.textContent).toMatch(
      /Only records an operator has published appear here/,
    );
  });

  /* ------------------------------------------------- the dated archive copy */

  it("is honest that there is no dated archive while the archive is off", async () => {
    serveManifest([MEETINGS]);
    // The default handler 404s /api/data/archive, which is what the backend
    // does while `dated_export_archive` is off.
    const { container } = renderWithProviders(<DataLicensePage />);
    await waitFor(() =>
      expect(container.textContent).toMatch(
        /no nightly snapshot and no dated archive/,
      ),
    );
    expect(container.textContent).not.toMatch(/Dated snapshots are kept/);
  });

  it("stops claiming there is no archive once the archive answers", async () => {
    serveManifest([MEETINGS]);
    serveArchive("2026-03-12T00:00:00.000Z");
    const { container } = renderWithProviders(<DataLicensePage />);

    await waitFor(() =>
      expect(container.textContent).toMatch(/Dated snapshots are kept/),
    );
    // The whole point: the paragraph cannot contradict the feature, and no
    // operator has to remember to come and edit it.
    expect(container.textContent).not.toMatch(
      /no nightly snapshot and no dated archive/,
    );
    // And it points somewhere useful — the earliest date it can answer for.
    expect(container.textContent).toMatch(
      new RegExp(new Date("2026-03-12T00:00:00.000Z").toLocaleDateString()),
    );
    expect(
      container.querySelector('a[href="/api/data/archive"]'),
    ).not.toBeNull();
  });

  it("promises nothing about dates before the first snapshot", async () => {
    serveManifest([MEETINGS]);
    serveArchive(null);
    const { container } = renderWithProviders(<DataLicensePage />);

    await waitFor(() =>
      expect(container.textContent).toMatch(/Dated snapshots are kept/),
    );
    expect(container.textContent).toMatch(/No snapshot has been taken yet/);
  });

  it("makes neither claim when the archive endpoint cannot be reached", async () => {
    serveManifest([MEETINGS]);
    server.use(
      http.get(
        "/api/data/archive",
        () => new HttpResponse(null, { status: 502 }),
      ),
    );
    const { container } = renderWithProviders(<DataLicensePage />);
    await waitFor(() =>
      expect(screen.getByText("meetings")).toBeInTheDocument(),
    );
    // A bad gateway is not evidence that the archive is absent, and a page that
    // reads a proxy fault as a fact about the record is the bug this task
    // exists to remove — in the other direction.
    expect(container.textContent).not.toMatch(
      /no nightly snapshot and no dated archive/,
    );
    expect(container.textContent).not.toMatch(/Dated snapshots are kept/);
  });

  it("carries Dataset JSON-LD that advertises only files the API serves", async () => {
    serveManifest([MEETINGS]);
    const { container } = renderWithProviders(<DataLicensePage />);
    await waitFor(() =>
      expect(screen.getByText("meetings")).toBeInTheDocument(),
    );

    const script = container.querySelector(
      'script[type="application/ld+json"]',
    );
    expect(script).not.toBeNull();
    const payload = JSON.parse(script!.textContent ?? "{}") as {
      "@type": string;
      license: string;
      distribution: Array<{ contentUrl: string }>;
    };
    expect(payload["@type"]).toBe("Dataset");
    expect(payload.license).toBe("https://creativecommons.org/licenses/by/4.0/");
    // Generated from the manifest, so it can never point at a file that is not
    // served — an invented contentUrl is a 404 a search engine publishes for us.
    expect(payload.distribution.map((entry) => entry.contentUrl)).toEqual([
      "https://commissionwatch.bmux.sh/api/data/meetings.csv",
      "https://commissionwatch.bmux.sh/api/data/meetings.json",
    ]);
  });

  it("says so plainly when the manifest cannot be loaded", async () => {
    server.use(
      http.get("/api/data", () => new HttpResponse(null, { status: 500 })),
    );
    renderWithProviders(<DataLicensePage />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not be loaded/);
    // The static half of the page still renders: the licence does not depend
    // on the record.
    expect(screen.getByText("The compiled dataset")).toBeInTheDocument();
  });
});

/**
 * The endpoint list against the routers that actually exist.
 *
 * The page listed six endpoints while the backend mounted twenty-seven, and to
 * a reader an endpoint absent from the list of endpoints is an endpoint that
 * does not exist. Everything shipped after the page was written — search, the
 * source viewer, places, transcripts, metrics, the corrections log, the
 * calendar, the bulk export itself — was missing.
 *
 * So the test reads `app.ts` rather than a copy of it. A mount is either on the
 * page or in `NOT_PUBLIC` with a reason somebody wrote down.
 */
describe("the API surface the page advertises is the one that is mounted", () => {
  /** Mounted, and deliberately not advertised as public read API. */
  const NOT_PUBLIC: Readonly<Record<string, string>> = {
    "/api/admin": "the operator console; behind requireOperator and never advertised",
    "/api/admin/discord": "operator-only channel configuration",
    "/api/sms": "a Twilio webhook, not a read endpoint — it is posted to, by one caller",
    "/api/subscriptions": "write endpoints for alert signup, not a public read surface",
    "/api/alerts": "the same; it takes an address and returns nothing to read",
    "/api/notifications": "operator-only; requireOperator on the router's first line",
    "/api/list-unsubscribe": "acted on from an email header, not browsed",
    "/sitemap.xml": "not JSON and not an API; it is named in robots.txt where crawlers look",
    "/api":
      "not a mount at all — the JSON 404 fall-through, registered last so it only " +
      "sees paths no router matched. Advertising it would list the absence of an " +
      "endpoint as an endpoint.",
  };

  it("lists every public mount, or says why one is absent", () => {
    const appSource = readFileSync(
      join(__dirname, "..", "..", "..", "backend", "src", "app.ts"),
      "utf8",
    );
    const mounts = [...appSource.matchAll(/app\.use\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(mounts.length).toBeGreaterThan(20);

    const page = readFileSync(join(__dirname, "DataLicensePage.tsx"), "utf8");
    const missing = mounts.filter(
      (mount) => !page.includes(`"${mount}"`) && !NOT_PUBLIC[mount],
    );

    expect(missing, `mounted and advertised nowhere: ${missing.join(", ")}`).toEqual([]);
  });

  /**
   * An allow-list is how a guard quietly stops guarding, so an exclusion has to
   * name something that is still mounted.
   */
  it("carries no stale exclusion", () => {
    const appSource = readFileSync(
      join(__dirname, "..", "..", "..", "backend", "src", "app.ts"),
      "utf8",
    );
    for (const [mount, reason] of Object.entries(NOT_PUBLIC)) {
      expect(appSource, `${mount} is excluded but no longer mounted`).toContain(`"${mount}"`);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});

