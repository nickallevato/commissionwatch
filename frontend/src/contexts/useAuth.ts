import { useContext } from "react";
import { AuthContext, type AuthContextValue } from "./auth-context";

/**
 * The hook sits beside the provider rather than inside it: AuthContext.tsx has
 * to export only AuthProvider for React Refresh to hot-swap the provider, and a
 * hook exported from that same file would break the boundary for the whole
 * admin tree.
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
