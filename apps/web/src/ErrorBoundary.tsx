import { Component, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="recovery-screen"><h1>Let’s reopen your map.</h1><p>The app could not display this screen. Reopen to try again. Your saved maps remain on this device.</p><button className="primary-button" onClick={() => location.reload()}>Reopen OFFGRID</button></main>;
  }
}
