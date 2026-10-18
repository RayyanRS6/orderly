import { Component, type ErrorInfo, type ReactNode } from 'react';

/** A page's code that failed to download (stale deploy or a dropped connection). */
const LOAD_FAILURE =
  /dynamically imported module|importing a module script failed|loading (css )?chunk|failed to fetch/i;

// Its own module (re-exported from ui.tsx) so the public pages' entry chunk can use it
// without pulling in the workspace UI and its dialog library.
export class ErrorBoundary extends Component<
  /** customer: a restaurant's public menu page, which has no workspace to reset. */
  { children: ReactNode; customer?: boolean },
  { hasError: boolean; error: Error | null }
> {
  state = { hasError: false, error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error in UI:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      const message = this.state.error?.message;
      // Browser download errors mean nothing to staff or customers; the console keeps them.
      const shown =
        this.props.customer || (message && LOAD_FAILURE.test(message))
          ? 'Check your connection and try again.'
          : message || 'An unexpected error occurred while rendering the workspace.';
      return (
        <div className="grid min-h-dvh place-items-center canvas-glow p-6 text-stone-800">
          <div className="card enter-rise w-full max-w-md p-7 sm:p-9">
            <h1 className="page-title">Something went wrong</h1>
            <p className="mt-2 text-sm text-stone-500 leading-relaxed">{shown}</p>
            <div className="mt-6 flex flex-col gap-2">
              <button
                className="btn btn-primary w-full"
                onClick={() => {
                  this.setState({ hasError: false, error: null });
                  window.location.reload();
                }}
              >
                Reload page
              </button>
              {!this.props.customer && (
                <button
                  type="button"
                  className="btn btn-quiet w-full text-xs text-stone-500 hover:text-stone-700"
                  onClick={() => {
                    try {
                      localStorage.removeItem('orderly.company');
                    } catch {}
                    window.location.href = '/';
                  }}
                >
                  Reset workspace and return home
                </button>
              )}
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
