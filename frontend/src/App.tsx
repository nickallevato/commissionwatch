import { Routes, Route, Navigate } from "react-router";
import { Layout } from "./components/Layout";
import { PressroomAuthLayout, PressroomLayout } from "./components/PressroomLayout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { HomePage } from "./pages/HomePage";
import { MeetingsPage } from "./pages/MeetingsPage";
import { MeetingDetailPage } from "./pages/MeetingDetailPage";
import { OfficialsPage } from "./pages/OfficialsPage";
import { OfficialPage } from "./pages/OfficialPage";
import { SearchPage } from "./pages/SearchPage";
import { SourcePage } from "./pages/SourcePage";
import { VotesPage } from "./pages/VotesPage";
import { ElectionsPage } from "./pages/ElectionsPage";
import { FindingsPage } from "./pages/FindingsPage";
import { MatterDetailPage } from "./pages/MatterDetailPage";
import { MattersPage } from "./pages/MattersPage";
import { MapPage } from "./pages/MapPage";
import { BotPage } from "./pages/BotPage";
import { MetricsPage } from "./pages/MetricsPage";
import { MethodologyPage } from "./pages/MethodologyPage";
import { PrivacyPage } from "./pages/PrivacyPage";
import { AccessibilityPage } from "./pages/AccessibilityPage";
import { PublicRecordsPage } from "./pages/PublicRecordsPage";
import { CorrectionsPage } from "./pages/CorrectionsPage";
import { DisputePage } from "./pages/DisputePage";
import { StatusPage } from "./pages/StatusPage";
import { DataLicensePage } from "./pages/DataLicensePage";
import { CalendarPage } from "./pages/CalendarPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { LoginPage } from "./pages/LoginPage";
import { AdminHomePage } from "./pages/AdminHomePage";
import { AdminChannelsPage } from "./pages/AdminChannelsPage";
import { AdminRecordsPage } from "./pages/AdminRecordsPage";
import { AdminSourcesPage } from "./pages/AdminSourcesPage";
import { AdminSourceMeetingsPage } from "./pages/AdminSourceMeetingsPage";
import { AdminRunDetailPage } from "./pages/AdminRunDetailPage";
import { AdminMeetingDetailPage } from "./pages/AdminMeetingDetailPage";
import { AdminReviewPage } from "./pages/AdminReviewPage";
import { AdminClaimsPage } from "./pages/AdminClaimsPage";
import { AdminPlaceLinksPage } from "./pages/AdminPlaceLinksPage";
import { AdminRosterPage } from "./pages/AdminRosterPage";
import { AdminFeaturesPage } from "./pages/AdminFeaturesPage";
import { SubscribePage } from "./pages/SubscribePage";
import { AuthProvider } from "./contexts/AuthContext";
import { ProtectedRoute } from "./components/ProtectedRoute";

/**
 * Every destination reachable from the masthead nav or the colophon has a route
 * here. A nav link with no matching route renders the 404 inside the full site
 * chrome, which reads as a broken site rather than a missing page — so the two
 * lists are kept in step deliberately, and `chrome-links.test.tsx` walks the
 * rendered nav and colophon and asserts that each href resolves to a page.
 */
export function App() {
  return (
    <AuthProvider>
      <Routes>
        {/* Inside Layout so a failed page keeps the masthead and nav — the user
          can still navigate away instead of facing a blank document. */}
        <Route
          element={
            <ErrorBoundary>
              <Layout />
            </ErrorBoundary>
          }
        >
          <Route index element={<HomePage />} />
          <Route path="meetings" element={<MeetingsPage />} />
          <Route path="meetings/:id" element={<MeetingDetailPage />} />
          <Route path="matters" element={<MattersPage />} />
          <Route path="matters/:id" element={<MatterDetailPage />} />
          <Route path="officials" element={<OfficialsPage />} />
          {/* One official as a subject: voting record, attendance, patterns
            and the campaign-finance overlay. Reached from the roster, not
            from the nav — the roster is the index of this page. */}
          <Route path="officials/:id" element={<OfficialPage />} />
          <Route path="search" element={<SearchPage />} />
          {/* The geography spec's public surface, at the address it names.
            It is not a slippy map and it does not pretend to be one: the
            site's content policy allows no third-party host, so there are no
            tiles to draw and the page says so. See MapPage's header. */}
          <Route path="map" element={<MapPage />} />
          {/* The address every citation points at. Reached from a citation
            chip, never from the nav — a content address is not something a
            reader browses to, it is something they arrive at holding. */}
          <Route path="source/:sha256" element={<SourcePage />} />
          <Route path="votes" element={<VotesPage />} />
          <Route path="elections" element={<ElectionsPage />} />
          <Route path="findings" element={<FindingsPage />} />
          <Route path="methodology" element={<MethodologyPage />} />
          <Route path="privacy" element={<PrivacyPage />} />
          <Route path="accessibility" element={<AccessibilityPage />} />
          {/* P7. The statutory route the Methodology page promises, as a page.
            Unauthenticated by design: a reader exercising a public right does
            not sign in to this project first. */}
          <Route path="public-records" element={<PublicRecordsPage />} />
          {/* The public collection status. Unauthenticated: it describes this
            site's own ingestion, not anybody's record. */}
          <Route path="status" element={<StatusPage />} />
          {/* This project measured by its own standard. Beside /status because
            both describe this site rather than the record it keeps. */}
          <Route path="metrics" element={<MetricsPage />} />
          {/* The page robots.txt points at. An invitation should say what is
            inside, and every machine-readable surface was previously
            discoverable only by reading the source or guessing a path. */}
          <Route path="bot" element={<BotPage />} />
          {/* B3. The corrections policy and the log that shows it is kept, and
            the route by which a person named in a record contests it. Both
            unauthenticated: the person who most needs them is the one this
            site has written about, and they do not have an account here. */}
          <Route path="corrections" element={<CorrectionsPage />} />
          <Route path="corrections/dispute" element={<DisputePage />} />
          {/* The open-data page answers at `/data`, which is the address the
            launch-readiness spec names and the one the Dataset JSON-LD points
            at. `/data-license` is kept as it was: it has been the published
            address of this page, and a transparency site does not break a URL
            it asked people to cite. */}
          <Route path="data" element={<DataLicensePage />} />
          <Route path="data-license" element={<DataLicensePage />} />
          {/* The public meeting calendar and the per-jurisdiction iCal feeds it
            links to. Published meetings only. */}
          <Route path="calendar" element={<CalendarPage />} />
          <Route path="subscribe" element={<SubscribePage />} />

          {/* Addresses this site published before the vocabulary was settled.
            Both are in sitemap.xml and being crawled, and a transparency
            project does not break a URL it asked people to cite — the same
            reasoning that keeps /data-license alive beside /data.

            `replace` so the old address does not sit in the reader's history
            waiting to be reached by the back button. nginx also answers these
            with a real 301 for a request that never reaches the app, which is
            what a crawler gets; this handles an in-app link that still points
            at the old path. See src/vocabulary.ts. */}
          <Route path="anomalies" element={<Navigate to="/findings" replace />} />
          <Route path="members" element={<Navigate to="/officials" replace />} />

        </Route>

        {/* The operator surface has a shell of its own. It used to render
          inside the public Layout, which meant an operator checking whether
          the scrapers had run was reading a newspaper masthead and a reader's
          nav. `ProtectedRoute` is a convenience, not the boundary: every
          /api/admin route 401s without a session regardless of what the
          browser renders. */}
        <Route
          element={
            <ErrorBoundary>
              <PressroomAuthLayout />
            </ErrorBoundary>
          }
        >
          <Route path="admin/login" element={<LoginPage />} />
        </Route>

        <Route
          element={
            <ErrorBoundary>
              <ProtectedRoute>
                <PressroomLayout />
              </ProtectedRoute>
            </ErrorBoundary>
          }
        >
          <Route path="admin" element={<AdminHomePage />} />
          <Route path="admin/channels" element={<AdminChannelsPage />} />
          <Route path="admin/records" element={<AdminRecordsPage />} />

          {/* The pressroom console. `/admin/sources` is the way in; the two
            detail routes are reached from a source row and from a meeting,
            which is why they carry an id rather than sitting in the rail. */}
          <Route path="admin/sources" element={<AdminSourcesPage />} />
          {/* The gate between ingested and public: a sweep produces candidates,
            an operator produces publications. */}
          <Route path="admin/sources/:id/meetings" element={<AdminSourceMeetingsPage />} />
          <Route path="admin/runs/:id" element={<AdminRunDetailPage />} />
          {/* B-a. The only screen from which a generated claim about a named
            person becomes public. */}
          <Route path="admin/review" element={<AdminReviewPage />} />
          {/* The other queue whose rows name a person. A finding is an
            inference about a pattern; a claim is a sentence quoting the
            minutes, and they are decided differently. */}
          <Route path="admin/claims" element={<AdminClaimsPage />} />
          {/* The third queue. A place link is not a sentence about a person —
            it is an assertion about where a decision happened, and the only
            thing that puts a pin on the public map. Until this screen existed
            `place_links.status` could only ever read `held`. */}
          <Route path="admin/place-links" element={<AdminPlaceLinksPage />} />
          {/* The roster roll. Not a queue: nothing here is decided and
            nothing here writes a member row. It is the per-body view of the
            gap `/metrics` can only publish as a distribution, because that
            endpoint is public and naming a body on it would enumerate the
            counties we hold withheld records for. */}
          <Route path="admin/roster" element={<AdminRosterPage />} />
          {/* The switch panel. Not a queue and not a record: it is the one
            screen that changes what this system does, and deliberately not one
            that changes what it refuses — no key it can write gates the
            publication wall, the review gate or the claim wall. */}
          <Route path="admin/features" element={<AdminFeaturesPage />} />
          <Route path="admin/meetings/:id" element={<AdminMeetingDetailPage />} />
        </Route>

        <Route
          element={
            <ErrorBoundary>
              <Layout />
            </ErrorBoundary>
          }
        >
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}
