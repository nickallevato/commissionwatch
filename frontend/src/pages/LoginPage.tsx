import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";

/**
 * `/admin/login` — the operator door.
 *
 * Rebuilt, not ported. The archive's login page was dark-themed and offered a
 * "Register" link; this product has one operator, no public sign-up by policy,
 * and a light editorial design system. Nothing here links to a registration
 * route, because none exists.
 *
 * The page is deliberately absent from the masthead nav. It is not a secret —
 * it just is not a destination a reader of a public record has any use for.
 */

const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

interface SsoProvider {
  readonly id: string;
  readonly label: string;
}

/**
 * Inert markup, per the operator's decision of 2026-08-09. Rendering the
 * buttons disabled records the intent without pulling an OIDC dependency into
 * a build that has no use for one yet. Tracked as B1.
 */
const SSO_PROVIDERS: readonly SsoProvider[] = [
  { id: "google", label: "Google" },
  { id: "github", label: "GitHub" },
];

export function LoginPage() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from =
    (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? "/admin";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await signIn(email, password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-md">
      <p className="kicker">Operator</p>
      <h1 className="headline text-3xl sm:text-4xl mt-1">Sign in</h1>
      <div className="rule-hi mt-4" role="presentation" />

      <p className="mt-5 max-w-prose text-sm leading-relaxed text-muted">
        This console is for the operator of this project. It is not a reader
        account, and there is no sign-up — everything published here is already
        public and needs no login to read.
      </p>

      <form onSubmit={handleSubmit} className="mt-8 space-y-5" noValidate>
        {error && (
          <p
            role="alert"
            className="border-l-2 border-accent bg-paper-sunk px-4 py-3 text-sm text-ink-soft"
          >
            {error}
          </p>
        )}

        <div>
          <label htmlFor="email" className="label-sm">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className={`mt-1.5 block w-full border border-rule bg-paper px-3 py-2 text-sm text-ink placeholder:text-muted hover:border-ink ${focusRing}`}
          />
        </div>

        <div>
          <label htmlFor="password" className="label-sm">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className={`mt-1.5 block w-full border border-rule bg-paper px-3 py-2 text-sm text-ink placeholder:text-muted hover:border-ink ${focusRing}`}
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          className={`w-full border border-ink bg-ink px-4 py-2.5 text-[11px] font-semibold uppercase tracking-label text-paper hover:bg-ink-soft disabled:opacity-50 ${focusRing}`}
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <div className="mt-10 flex items-center gap-4">
        <span className="h-px flex-1 bg-rule" aria-hidden="true" />
        <span className="label-sm">Or</span>
        <span className="h-px flex-1 bg-rule" aria-hidden="true" />
      </div>

      <ul className="mt-5 space-y-3">
        {SSO_PROVIDERS.map((provider) => (
          <li key={provider.id}>
            <button
              type="button"
              disabled
              aria-disabled="true"
              className="flex w-full items-center justify-between border border-rule px-4 py-2.5 text-sm text-muted opacity-60"
            >
              <span>Continue with {provider.label}</span>
              <span className="label-sm">Soon</span>
            </button>
          </li>
        ))}
      </ul>

      <p className="mt-6 text-xs leading-relaxed text-muted">
        Single sign-on is not wired up yet. Until it is, these buttons do
        nothing — they are here so the shape of the page does not change when it
        arrives.
      </p>
    </div>
  );
}
