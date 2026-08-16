import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { ReactNode } from "react";
import { http, HttpResponse } from "msw";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { MapPage } from "./MapPage";
import { server } from "@/mocks/server";
import { metrics } from "@/mocks/data";
import type { PlaceDetail, PlaceLinkView, PlaceNearResult } from "@/types";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/**
 * `/map` — the page that must not lie about where something is.
 *
 * Four of these assertions are the feature rather than coverage of it:
 *
 *  - an empty answer is `<Absence>` and never "there is nothing near you". The
 *    table is empty because extraction has not run, and a page that turned our
 *    silence into a claim about the reader's neighbourhood would be the exact
 *    misrepresentation the `<Absence>` grammar exists to prevent;
 *  - a `centroid` or `block` position is drawn and worded differently from an
 *    `exact` one, and its distance is rounded to its own uncertainty;
 *  - nothing is drawn without a citation, and what is held back is counted;
 *  - `navigator.geolocation` is not touched until a reader presses the button
 *    that touches it. That one is asserted rather than merely avoided, because
 *    "we don't call it" is a claim about code nobody re-reads.
 */

const CENTRE = { lat: 45.6796, lon: -111.0386 };

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

  return render(<MapPage />, { wrapper: Providers });
}

function place(over: Partial<PlaceNearResult> = {}): PlaceNearResult {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    jurisdiction_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    kind: "address",
    label: "1200 N Rouse Ave",
    // 437 m north of the centre, so the rounding the precision imposes is
    // visible in the rendered distance rather than hidden by a round number.
    lat: CENTRE.lat + 437 / 110_540,
    lon: CENTRE.lon,
    precision: "exact",
    external_ref: null,
    external_source: null,
    geocoder: "census",
    geocoded_at: "2026-08-15T00:00:00.000Z",
    distance_metres: 437,
    ...over,
  };
}

function link(over: Partial<PlaceLinkView> = {}): PlaceLinkView {
  return {
    id: "99999999-9999-9999-9999-999999999999",
    subject_kind: "agenda_item",
    subject_id: "22222222-2222-2222-2222-222222222222",
    relation: "subject_of",
    confidence: "stated",
    artifact_sha256: "a1b2c3d4".repeat(8),
    quote: "a zone map amendment for the property at 1200 North Rouse Avenue",
    quote_offset: 4096,
    updated_at: "2026-08-15T00:00:00.000Z",
    ...over,
  };
}

/** Serve a near answer, and a detail answer for each place given. */
function serve(entries: Array<{ near: PlaceNearResult; links: PlaceLinkView[] }>) {
  server.use(
    http.get("/api/places/near", ({ request }) => {
      const radius = Number(new URL(request.url).searchParams.get("radius") ?? 500);
      return HttpResponse.json({
        data: entries.map((entry) => entry.near),
        radius,
        limit: 25,
      });
    }),
    http.get("/api/places/:id", ({ params }) => {
      const entry = entries.find((candidate) => candidate.near.id === params.id);
      if (entry === undefined) {
        return HttpResponse.json(
          { error: "Place not found", statusCode: 404 },
          { status: 404 },
        );
      }
      const detail: PlaceDetail = { ...entry.near, links: entry.links };
      return HttpResponse.json(detail);
    }),
  );
}

const NEAR = `/map?near=${CENTRE.lat},${CENTRE.lon}&radius=500`;

describe("MapPage", () => {
  /**
   * This asserted a single empty-state sentence until `/api/metrics` grew
   * `places_total` and `places_public`. The page could tell two states apart
   * and needed four, and the difference is not cosmetic: "nothing near you" is
   * a statement about a neighbourhood, while the other three are statements
   * about us. Each branch gets its own assertion, and the strongest claim is
   * asserted absent from all of them but the last.
   */
  it("says nothing has been located anywhere when nothing has", async () => {
    server.use(
      http.get("/api/metrics", () =>
        HttpResponse.json({ ...metrics, quality: { ...metrics.quality, places_total: 0, places_public: 0 } }),
      ),
    );
    renderAt(NEAR);

    expect(
      await screen.findByText(/nothing anywhere has been tied to a location yet/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/statement about this project, not about your neighbourhood/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/the record shows no/i)).not.toBeInTheDocument();
  });

  it("says located-but-unreviewed rather than implying nothing was found", async () => {
    // The default fixture is 12 located, 0 public — the state a fixture of
    // all-zeroes would never exercise, and the one most likely to be rendered
    // as "nothing here".
    renderAt(NEAR);

    expect(await screen.findByText(/none has been through review yet/i)).toBeInTheDocument();
    expect(screen.getByText(/a person checks it first/i)).toBeInTheDocument();
    expect(screen.queryByText(/the record shows no/i)).not.toBeInTheDocument();
  });

  /**
   * Only once something is published elsewhere is silence about the
   * neighbourhood rather than about us — and even then the page offers a wider
   * radius rather than asserting the area is quiet.
   */
  it("makes the stronger claim only when there is something to compare against", async () => {
    server.use(
      http.get("/api/metrics", () =>
        HttpResponse.json({ ...metrics, quality: { ...metrics.quality, places_total: 40, places_public: 31 } }),
      ),
    );
    renderAt(NEAR);

    expect(await screen.findByText(/try a wider radius/i)).toBeInTheDocument();
  });

  /**
   * A fourth state. An unanswered metrics request must not borrow the wording
   * of any of the other three — falling back to the most flattering reading of
   * an unknown is the failure this whole component exists to prevent.
   */
  it("does not guess when it could not check", async () => {
    server.use(http.get("/api/metrics", () => new HttpResponse(null, { status: 500 })));
    renderAt(NEAR);

    // The `request-failed` sentence, which names this as our failure rather
    // than as a fact about the record. `not-yet-ingested` — "No sweep has
    // collected located decisions yet" — is the wrong claim here and reads
    // almost identically in a component tree, which is how it got used.
    expect(
      await screen.findByText(/could not be loaded\. That is a failure on our side/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/cannot tell an empty neighbourhood from a gap in our own collection/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No sweep has collected/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/try a wider radius/i)).not.toBeInTheDocument();
  });

  it("distinguishes a coarse position from an exact one, in words and in the figure", async () => {
    serve([
      { near: place(), links: [link()] },
      {
        near: place({
          id: "33333333-3333-3333-3333-333333333333",
          label: "Northeast Urban Renewal District",
          kind: "project_area",
          precision: "centroid",
          distance_metres: 437,
        }),
        links: [link({ id: "88888888-8888-8888-8888-888888888888" })],
      },
    ]);

    const { container } = renderAt(NEAR);

    await screen.findByText("1200 N Rouse Ave");
    expect(screen.getByText("Exact")).toBeInTheDocument();
    expect(screen.getByText("Area centre")).toBeInTheDocument();
    expect(
      screen.getByText(/the centre of an area, not a point on the ground/i),
    ).toBeInTheDocument();

    // The same 437 metres, stated to the precision each position supports:
    // 10 m for an exact geocode, 250 m for an area centre. A centroid that
    // reported "440 m" would be claiming a metre the record never had.
    expect(screen.getByText("About 440 m away")).toBeInTheDocument();
    expect(screen.getByText("About 500 m away")).toBeInTheDocument();

    // In the figure: an exact geocode is a filled point, anything coarser is an
    // unfilled extent drawn at its own uncertainty, so the two cannot be read
    // as the same kind of mark.
    const marks = [...container.querySelectorAll("circle")].filter(
      (circle) => circle.getAttribute("stroke") === "var(--cw-ink)",
    );
    expect(marks).toHaveLength(2);
    const filled = marks.filter((mark) => mark.getAttribute("fill") === "var(--cw-ink)");
    expect(filled).toHaveLength(1);
    const [exactMark] = filled;
    const [coarseMark] = marks.filter((mark) => mark.getAttribute("fill") === "none");
    expect(Number(coarseMark.getAttribute("r"))).toBeGreaterThan(
      Number(exactMark.getAttribute("r")),
    );
  });

  it("lists a jurisdiction-precision place without placing it anywhere", async () => {
    serve([
      {
        near: place({
          label: "Gallatin County",
          kind: "facility",
          precision: "jurisdiction",
          distance_metres: 120,
        }),
        links: [link()],
      },
    ]);

    const { container } = renderAt(NEAR);

    await screen.findByText("Gallatin County");
    // No distance, because there is no position to measure from. Printing
    // "120 m" would invent one out of a row that says only which county this is.
    expect(screen.getByText("Distance not stated")).toBeInTheDocument();
    expect(
      screen.getByText(/all that is known is which jurisdiction this belongs to/i),
    ).toBeInTheDocument();
    expect(
      [...container.querySelectorAll("circle")].filter(
        (circle) => circle.getAttribute("stroke") === "var(--cw-ink)",
      ),
    ).toHaveLength(0);
  });

  it("shows the quotation behind every place it draws", async () => {
    serve([{ near: place(), links: [link()] }]);

    renderAt(NEAR);

    await screen.findByText("1200 N Rouse Ave");
    expect(
      screen.getByText(/a zone map amendment for the property at 1200 North Rouse Avenue/),
    ).toBeInTheDocument();
    // The address of the bytes, linked at the source viewer with the offset the
    // citation carries — the same furniture as every other claim on the site.
    const source = screen.getByRole("link", { name: /a1b2c3…b2c3d4/ });
    // `len` comes off the quote itself — only the citation knows how far the
    // marked span runs, and hardcoding a length here would be a second copy of
    // that fact waiting to disagree with the first.
    expect(source).toHaveAttribute(
      "href",
      `/source/${"a1b2c3d4".repeat(8)}?offset=4096&len=${link().quote?.length}`,
    );
    // `confidence` is the honesty column, so it reaches the reader too.
    expect(screen.getByText(/the record names this location/i)).toBeInTheDocument();
  });

  it("draws nothing it cannot source, and says how much it held back", async () => {
    serve([
      {
        near: place(),
        // What an `inferred` link looks like on the wire: no artifact, no quote,
        // no offset. `wherePlaceLinkPublic` should never send one — this asserts
        // what happens if it ever does.
        links: [link({ artifact_sha256: null, quote: null, quote_offset: null })],
      },
    ]);

    renderAt(NEAR);

    await screen.findByText(/no quotation from a published record could be shown/i);
    expect(screen.queryByText("1200 N Rouse Ave")).not.toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("offers the near feed with the coordinate and radius, and says nothing is stored", async () => {
    renderAt(`/map?near=${CENTRE.lat},${CENTRE.lon}&radius=1000`);

    const subscribe = await screen.findByRole("link", { name: /subscribe to this area/i });
    expect(subscribe).toHaveAttribute(
      "href",
      `/feed.xml?near=${encodeURIComponent("45.6796,-111.0386")}&radius=1000`,
    );
    expect(
      screen.getByText(/we keep no record of who is subscribed/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/no account, no\s+email address/i)).toBeInTheDocument();
  });

  it("does not ask the browser for a location until the reader presses the button", async () => {
    const getCurrentPosition = vi.fn();
    // jsdom implements no geolocation at all, so the property has to be defined
    // to be observed. Configurable, and removed afterwards, so no other suite
    // inherits a navigator this one invented.
    Object.defineProperty(navigator, "geolocation", {
      value: { getCurrentPosition },
      configurable: true,
    });

    try {
      const user = userEvent.setup();
      renderAt("/map");

      // Mount, render, settle. Nothing here may reach for the reader's position.
      await screen.findByRole("heading", { level: 1, name: "Nearby" });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /use my location/i })).toBeEnabled(),
      );
      expect(getCurrentPosition).not.toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: /use my location/i }));
      expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(navigator, "geolocation");
    }
  });

  it("coarsens the reader's own position before writing it anywhere", async () => {
    // A browser hands back a fix good to a few metres. What this page does with
    // it ends up in the address bar, in history, and in any link the reader
    // shares — so the digits that identify a house must not survive the trip.
    // 110 m is coarse enough for that and finer than the smallest radius the
    // page offers, so the answer does not change.
    const getCurrentPosition = vi.fn((onSuccess: PositionCallback) => {
      onSuccess({
        coords: {
          latitude: 45.6791234,
          longitude: -111.0384567,
          accuracy: 5,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          speed: null,
        },
        timestamp: 0,
      } as GeolocationPosition);
    });
    Object.defineProperty(navigator, "geolocation", {
      value: { getCurrentPosition },
      configurable: true,
    });

    try {
      const user = userEvent.setup();
      renderAt("/map");
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /use my location/i })).toBeEnabled(),
      );

      await user.click(screen.getByRole("button", { name: /use my location/i }));

      const field = await screen.findByDisplayValue("45.679, -111.038");
      expect(field).toBeInTheDocument();
      expect(screen.queryByDisplayValue(/45\.6791/)).not.toBeInTheDocument();
    } finally {
      Reflect.deleteProperty(navigator, "geolocation");
    }
  });

  it("fires no request at all until a coordinate is given", async () => {
    const asked: string[] = [];
    server.events.on("request:start", ({ request }) => {
      if (new URL(request.url).pathname.startsWith("/api/places")) {
        asked.push(request.url);
      }
    });

    try {
      renderAt("/map");
      await screen.findByText(/give a coordinate to see which decisions/i);

      // A page that fired this on mount would have to invent a centre, and the
      // only centres available are the reader's own position and a guess.
      expect(asked).toEqual([]);
    } finally {
      // In a `finally` so a failure here does not leave a listener attached to
      // the shared server for every suite that runs after it.
      server.events.removeAllListeners("request:start");
    }
  });

  it("references no third-party host anywhere on the page", async () => {
    serve([{ near: place(), links: [link()] }]);

    const { container } = renderAt(NEAR);

    await screen.findByText("1200 N Rouse Ave");
    // The site's CSP allows no host beyond the origin, so a tile URL, a font or
    // an SDK would be blocked in the browser and render as a hole. This asserts
    // the page never asks: no absolute URL is emitted at all.
    expect(container.innerHTML).not.toMatch(/https?:\/\//);
  });
});
