import { Component, type ErrorInfo, type ReactNode } from 'react';

interface DashboardErrorBoundaryProps {
  children: ReactNode;
  onRecover?: () => void;
  onError?: (error: Error, info: ErrorInfo) => void;
  resetKeys?: readonly unknown[];
}

interface DashboardErrorBoundaryState {
  error: Error | null;
}

function resetKeysChanged(
  previous: readonly unknown[] | undefined,
  current: readonly unknown[] | undefined,
): boolean {
  if (previous === current) return false;
  if (!previous || !current || previous.length !== current.length) return true;
  return previous.some((value, index) => !Object.is(value, current[index]));
}

/** Keeps the application controls available if the chart/dashboard render fails. */
export class DashboardErrorBoundary extends Component<
  DashboardErrorBoundaryProps,
  DashboardErrorBoundaryState
> {
  state: DashboardErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): DashboardErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  componentDidUpdate(previousProps: DashboardErrorBoundaryProps): void {
    if (
      this.state.error &&
      resetKeysChanged(previousProps.resetKeys, this.props.resetKeys)
    ) {
      this.setState({ error: null });
    }
  }

  private recover = (): void => {
    this.props.onRecover?.();
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <main className="dashboard-error" role="alert" aria-live="assertive">
        <div className="dashboard-error-card">
          <span className="eyebrow">DASHBOARD RECOVERY</span>
          <h1>Visualisasi berhenti dengan aman</h1>
          <p>
            Chart ditutup sementara agar error render tidak menampilkan data market
            yang mungkin menyesatkan.
          </p>
          <code>{this.state.error.message || 'Unknown dashboard error'}</code>
          <button type="button" onClick={this.recover}>
            Pulihkan dashboard
          </button>
        </div>
      </main>
    );
  }
}
