import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time exceptions so a single bad component cannot blank the
 * whole site.
 *
 * Before this existed, any thrown error produced a completely white page with
 * nothing but a stack trace in the console — an adversarial QA pass found every
 * content route doing exactly that once the API started returning real data.
 *
 * A transparency site that fails silently is worse than one that says it
 * failed, so this states plainly that something broke and offers a way out.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled render error:", error, info.componentStack);
  }

  handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div role="alert" className="mx-auto max-w-2xl px-6 py-16">
        <p className="kicker">Error</p>
        <h1 className="headline mb-4">This page failed to load</h1>
        <p className="mb-6 font-sans text-sm leading-relaxed text-muted">
          Something went wrong rendering this page. The rest of the site is
          unaffected. If this keeps happening, it is a bug worth reporting.
        </p>

        <div className="flex flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={this.handleRetry}
            className="border border-ink px-4 py-2 font-sans text-sm text-ink transition-colors hover:bg-ink hover:text-paper"
          >
            Try again
          </button>
          <a href="/" className="font-sans text-sm text-accent underline">
            Go back home
          </a>
        </div>

        <details className="mt-8">
          <summary className="label-sm cursor-pointer">
            Technical detail
          </summary>
          <pre className="mt-3 overflow-x-auto border border-rule bg-paper-sunk p-4 text-xs text-muted">
            {error.message}
          </pre>
        </details>
      </div>
    );
  }
}
