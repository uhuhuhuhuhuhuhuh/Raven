import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Raven UI crash', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="fatal-error">
          <div className="fatal-panel">
            <div className="brand-mark">R</div>
            <h1>RAVEN UI RECOVERY</h1>
            <p>The interface encountered an unexpected rendering error. No camera source or browser data was modified.</p>
            <code>{this.state.error.message}</code>
            <button onClick={() => window.location.reload()}>RELOAD RAVEN</button>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}
