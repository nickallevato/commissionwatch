import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "../contexts/useAuth";

/**
 * Guards the admin surface in the browser. It is not the security boundary —
 * that is `requireOperator` on the API, which 401s every `/api/admin/*` route
 * without a live session. This only spares a signed-out operator a page that
 * would render nothing but errors.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { operator, loading } = useAuth();
  const location = useLocation();

  // Nothing decisive until the session probe resolves — redirecting first
  // would bounce a signed-in operator to the login form on every reload.
  if (loading) {
    return (
      <p className="label-sm" role="status">
        Checking session…
      </p>
    );
  }

  if (!operator) {
    return <Navigate to="/admin/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}
