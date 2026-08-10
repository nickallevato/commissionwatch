import { createContext } from "react";

/**
 * The context object and its shapes sit apart from AuthProvider because a file
 * that exports both a component and a context cannot be hot-swapped by React
 * Refresh — every edit to the provider would reload the whole admin tree.
 * Application code should read the session through `useAuth`, not from here.
 */

export interface Operator {
  id: string;
  email: string;
  name: string;
  role: string;
  last_login_at: string | null;
}

export interface AuthContextValue {
  operator: Operator | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
