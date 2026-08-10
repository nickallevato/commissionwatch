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
import { DataLicensePage } from "./pages/DataLicensePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { LoginPage } from "./pages/LoginPage";
import { AdminHomePage } from "./pages/AdminHomePage";
import { AdminChannelsPage } from "./pages/AdminChannelsPage";
import { AdminRecordsPage } from "./pages/AdminRecordsPage";
import { AdminSourcesPage } from "./pages/AdminSourcesPage";
import { AdminRunDetailPage } from "./pages/AdminRunDetailPage";
import { AdminMeetingDetailPage } from "./pages/AdminMeetingDetailPage";
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
