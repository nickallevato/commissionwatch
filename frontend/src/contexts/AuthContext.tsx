import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface Operator {
  id: string;
  email: string;
  name: string;
  role: string;
  last_login_at: string | null;
}

interface AuthContextValue {
  operator: Operator | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}

/**
 * The session lives in an httpOnly cookie, which JavaScript cannot read by
 * design. So "am I signed in?" is a request, not a local-storage lookup — one
 * round trip on mount, in exchange for a credential no injected script can
 * steal. That trade is the whole reason this is not the archive's JWT.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [operator, setOperator] = useState<Operator | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function probe() {
      try {
        const res = await fetch("/api/admin/session", { credentials: "same-origin" });
        if (cancelled) return;
        if (res.ok) {
          const body = (await res.json()) as { operator: Operator };
          setOperator(body.operator);
        } else {
          setOperator(null);
        }
      } catch {
        if (!cancelled) setOperator(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void probe();
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const res = await fetch("/api/admin/session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      // The API answers every failure identically on purpose. The UI says the
      // same thing rather than inventing a distinction the server refuses to
      // make — "no such account" would leak exactly what the API withholds.
      throw new Error("Those credentials were not accepted.");
    }
    const body = (await res.json()) as { operator: Operator };
    setOperator(body.operator);
  }, []);

  const signOut = useCallback(async () => {
    await fetch("/api/admin/session", { method: "DELETE", credentials: "same-origin" });
    setOperator(null);
  }, []);

  const value = useMemo(
    () => ({ operator, loading, signIn, signOut }),
    [operator, loading, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
