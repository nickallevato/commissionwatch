import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";

/**
 * `/admin` — the console shell.
 *
 * Deliberately close to empty. It exists so the authenticated surface is real
 * and testable from the day authentication lands, rather than being asserted
 * only by unit tests. Delivery channels (B-e) and records requests (B-d) mount
 * their pages behind this same guard.
 */

const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

interface ConsoleSurface {
  readonly to: string;
  readonly title: string;
  readonly detail: string;
}

const SURFACES: readonly ConsoleSurface[] = [
  {
    to: "/admin/channels",
    title: "Delivery channels",
    detail:
      "Where findings go. Stored credentials are encrypted and never read back — a change is a replacement.",
  },
  {
    to: "/admin/records",
    title: "Records requests",
    detail:
      "Public-records requests, and documents obtained by hand entering the same pipeline as scraped ones.",
  },
];

export function AdminHomePage() {
  const { operator, signOut } = useAuth();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
      navigate("/admin/login", { replace: true });
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div>
      <p className="kicker">Operator console</p>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="headline text-3xl sm:text-4xl">
          {operator ? operator.name : "Console"}
        </h1>
        <button
          type="button"
          onClick={handleSignOut}
          disabled={signingOut}
          className={`border border-rule px-3 py-1.5 text-[11px] font-semibold uppercase tracking-label text-muted hover:border-ink hover:text-ink disabled:opacity-50 ${focusRing}`}
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
      <div className="rule-hi mt-4" role="presentation" />

      {operator && (
        <dl className="mt-6 grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="label-sm">Signed in as</dt>
            <dd className="mt-1 text-sm text-ink">{operator.email}</dd>
          </div>
          <div>
            <dt className="label-sm">Role</dt>
            <dd className="mt-1 text-sm text-ink">{operator.role}</dd>
          </div>
          <div>
            <dt className="label-sm">Previous sign-in</dt>
            <dd className="mt-1 text-sm text-ink tabular">
              {operator.last_login_at
                ? new Date(operator.last_login_at).toLocaleString()
                : "First session"}
            </dd>
          </div>
        </dl>
      )}

      <h2 className="mt-12 font-display text-xl font-semibold text-ink">Surfaces</h2>
      <ul className="mt-4 divide-y divide-rule border-y border-rule">
        {SURFACES.map((surface) => (
          <li key={surface.to} className="py-4">
            <Link
              to={surface.to}
              className={`text-sm font-semibold text-ink underline decoration-rule underline-offset-4 hover:decoration-accent ${focusRing}`}
            >
              {surface.title}
            </Link>
            <p className="mt-1 max-w-prose text-sm leading-relaxed text-muted">
              {surface.detail}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
