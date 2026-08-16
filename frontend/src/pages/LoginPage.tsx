import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { useAuth } from "../contexts/useAuth";
import { ACTION_PRIMARY, FIELD, FOCUS_RING } from "../components/PressroomUI";

/**
 * `/admin/login` — the operator door. Screen 01 of the approved mockup.
 *
 * Rebuilt, not ported. The archive's login page was dark-themed and offered a
 * "Register" link; this product has one operator, no public sign-up by policy,
 * and a light editorial design system. Nothing here links to a sign-up route,
 * because none exists.
 *
 * The masthead is the page's visual heading and `Sign in` is its accessible
 * one — a centred wordmark reads as a masthead to a person and as nothing at
 * all to a screen reader, so the page says what it is in both registers.
 *
 * The SSO buttons are real UI in a disabled state, with a date-bearing label.
 * A greyed control that says when it arrives sets an expectation you can keep;
 * a hidden feature sets none, and gets rebuilt from scratch later.
 */

interface SsoProvider {
  readonly id: string;
  readonly label: string;
  /** The brand glyph, inline. No icon dependency for two paths. */
  readonly path: string;
}

/**
 * Inert markup, per the operator's decision of 2026-08-09. Rendering the
 * buttons disabled records the intent without pulling an OIDC dependency into
 * a build that has no use for one yet. Tracked as B1.
 */
const SSO_PROVIDERS: readonly SsoProvider[] = [
  {
    id: "google",
    label: "Google",
    path: "M21.35 11.1H12v3.2h5.35c-.23 1.4-1.7 4.1-5.35 4.1a5.9 5.9 0 0 1 0-11.8c1.7 0 2.85.73 3.5 1.35l2.4-2.3A9 9 0 1 0 12 21c5.2 0 8.65-3.65 8.65-8.8 0-.6-.07-1.05-.3-1.1Z",
  },
  {
    id: "github",
    label: "GitHub",
    path: "M12 .5A11.5 11.5 0 0 0 8.4 22.9c.57.1.78-.25.78-.55v-2c-3.2.7-3.87-1.37-3.87-1.37-.53-1.33-1.29-1.69-1.29-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.12 3.05.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.4-5.26 5.69.41.36.78 1.06.78 2.14v3.17c0 .3.2.66.79.55A11.5 11.5 0 0 0 12 .5Z",
  },
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
    <div className="flex flex-col gap-4">
      <h1 className="sr-only">Sign in</h1>

      <div className="flex flex-col gap-1 text-center">
        <span
          aria-hidden="true"
          className="font-display text-[29px] font-semibold leading-headline tracking-headline text-ink"
        >
          CommissionWatch
        </span>
        <span
          aria-hidden="true"
          className="text-[10px] font-bold uppercase tracking-label text-accent"
        >
          Operator access
        </span>
      </div>

      <div className="border-t-[3px] border-double border-rule" role="presentation" />

      <p className="text-center text-xs leading-relaxed text-muted">
        This console is for the operator of this project. It is not a reader
        account, and there is no sign-up — everything published here is already
        public and needs no login to read.
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
        {error && (
          <p
            role="alert"
            className="border-l-2 border-accent bg-accent-50 px-4 py-3 text-sm text-ink-soft"
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
            className={`${FIELD} ${FOCUS_RING}`}
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
            className={`${FIELD} ${FOCUS_RING}`}
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          className={`${ACTION_PRIMARY} w-full justify-center py-2.5 ${FOCUS_RING}`}
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <div className="flex items-center gap-2.5">
        <span className="h-px flex-1 bg-rule" aria-hidden="true" />
        <span className="label-sm">Or</span>
        <span className="h-px flex-1 bg-rule" aria-hidden="true" />
      </div>

      <ul className="flex flex-col gap-2">
        {SSO_PROVIDERS.map((provider) => (
          <li key={provider.id}>
            <button
              type="button"
              disabled
              aria-disabled="true"
              className="flex w-full cursor-not-allowed items-center justify-center gap-2.5 border border-dashed border-rule bg-paper-sunk px-3 py-2.5 text-[12.5px] text-muted"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" className="opacity-45">
                <path fill="currentColor" d={provider.path} />
              </svg>
              Continue with {provider.label}
              <span className="border border-current px-1.5 py-px text-[9px] font-bold uppercase tracking-label">
                Soon
              </span>
            </button>
          </li>
        ))}
      </ul>

      <p className="text-center text-[11px] leading-relaxed text-muted">
        Single sign-on is not wired up yet — the buttons are here so the shape of
        the page does not change when it arrives.
        <br />
        Access is additionally restricted at the network edge.
        <br />
        Failed attempts are rate-limited and logged.
      </p>
    </div>
  );
}
