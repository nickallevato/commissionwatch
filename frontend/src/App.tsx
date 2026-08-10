import { Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { HomePage } from "./pages/HomePage";
import { MeetingsPage } from "./pages/MeetingsPage";
import { MeetingDetailPage } from "./pages/MeetingDetailPage";
import { MembersPage } from "./pages/MembersPage";
import { SearchPage } from "./pages/SearchPage";
import { VotesPage } from "./pages/VotesPage";
import { AnomaliesPage } from "./pages/AnomaliesPage";
import { MethodologyPage } from "./pages/MethodologyPage";
import { PublicRecordsPage } from "./pages/PublicRecordsPage";
import { CorrectionsPage } from "./pages/CorrectionsPage";
import { DisputePage } from "./pages/DisputePage";
import { StatusPage } from "./pages/StatusPage";
import { DataLicensePage } from "./pages/DataLicensePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { LoginPage } from "./pages/LoginPage";
import { AdminHomePage } from "./pages/AdminHomePage";
import { AdminChannelsPage } from "./pages/AdminChannelsPage";
import { AdminRecordsPage } from "./pages/AdminRecordsPage";
import { AdminSourcesPage } from "./pages/AdminSourcesPage";
import { AdminRunDetailPage } from "./pages/AdminRunDetailPage";
import { AdminMeetingDetailPage } from "./pages/AdminMeetingDetailPage";
import { AdminReviewPage } from "./pages/AdminReviewPage";
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
          <Route path="members" element={<MembersPage />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="votes" element={<VotesPage />} />
          <Route path="anomalies" element={<AnomaliesPage />} />
          <Route path="methodology" element={<MethodologyPage />} />
          {/* P7. The statutory route the Methodology page promises, as a page.
            Unauthenticated by design: a reader exercising a public right does
            not sign in to this project first. */}
          <Route path="public-records" element={<PublicRecordsPage />} />
          {/* The public collection status. Unauthenticated: it describes this
            site's own ingestion, not anybody's record. */}
          <Route path="status" element={<StatusPage />} />
          {/* B3. The corrections policy and the log that shows it is kept, and
            the route by which a person named in a record contests it. Both
            unauthenticated: the person who most needs them is the one this
            site has written about, and they do not have an account here. */}
          <Route path="corrections" element={<CorrectionsPage />} />
          <Route path="corrections/dispute" element={<DisputePage />} />
          <Route path="data-license" element={<DataLicensePage />} />
          <Route path="subscribe" element={<SubscribePage />} />

          {/* The operator surface. Inside the Layout so it is recognisably the
            same site, and deliberately absent from the masthead nav — it is
            not a destination a reader of a public record has any use for.
            `ProtectedRoute` is a convenience, not the boundary: every
            /api/admin route 401s without a session regardless of what the
            browser renders. */}
          <Route path="admin/login" element={<LoginPage />} />
          <Route
            path="admin"
            element={
              <ProtectedRoute>
                <AdminHomePage />
              </ProtectedRoute>
            }
          />
          <Route
            path="admin/channels"
            element={
              <ProtectedRoute>
                <AdminChannelsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="admin/records"
            element={
              <ProtectedRoute>
                <AdminRecordsPage />
              </ProtectedRoute>
            }
          />

          {/* The pressroom console. `/admin/sources` is the way in; the two
            detail routes are reached from a source row and from a meeting,
            which is why they carry an id rather than sitting in a nav. */}
          <Route
            path="admin/sources"
            element={
              <ProtectedRoute>
                <AdminSourcesPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="admin/runs/:id"
            element={
              <ProtectedRoute>
                <AdminRunDetailPage />
              </ProtectedRoute>
            }
          />
          {/* B-a. The only screen from which a generated claim about a named
            person becomes public. */}
          <Route
            path="admin/review"
            element={
              <ProtectedRoute>
                <AdminReviewPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="admin/meetings/:id"
            element={
              <ProtectedRoute>
                <AdminMeetingDetailPage />
              </ProtectedRoute>
            }
          />

          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}
