import { Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { HomePage } from "./pages/HomePage";
import { MeetingsPage } from "./pages/MeetingsPage";
import { MeetingDetailPage } from "./pages/MeetingDetailPage";
import { MembersPage } from "./pages/MembersPage";
import { VotesPage } from "./pages/VotesPage";
import { AnomaliesPage } from "./pages/AnomaliesPage";
import { MethodologyPage } from "./pages/MethodologyPage";
import { DataLicensePage } from "./pages/DataLicensePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { LoginPage } from "./pages/LoginPage";
import { AdminHomePage } from "./pages/AdminHomePage";
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
          <Route path="votes" element={<VotesPage />} />
          <Route path="anomalies" element={<AnomaliesPage />} />
          <Route path="methodology" element={<MethodologyPage />} />
          <Route path="data-license" element={<DataLicensePage />} />

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

          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}
