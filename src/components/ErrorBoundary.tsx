import { Component, type ErrorInfo, type ReactNode } from 'react';

// Its own module (re-exported from ui.tsx) so the public pages' entry chunk can use it
// without pulling in the workspace UI and its dialog library.
export class ErrorBoundary extends Component<
  { children: ReactNode },
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
      return (
        <div className="grid min-h-dvh place-items-center canvas-glow p-6 text-stone-800">
          <div className="card enter-rise w-full max-w-md p-7 sm:p-9">
            <h1 className="page-title">Something went wrong</h1>
            <p className="mt-2 text-sm text-stone-500 leading-relaxed">
              {this.state.error?.message ||
                'An unexpected error occurred while rendering the workspace.'}
            </p>
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
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
