/**
 * ErrorBoundary — catches uncaught React rendering errors in child components.
 *
 * Displays either a custom fallback or a default "Something went wrong" card
 * with a "Try Again" button that resets the error state.
 * Logs the error and component stack to the console via componentDidCatch.
 */

import React, { Component } from 'react';

/** Props for the ErrorBoundary component. */
interface Props {
  /** Child components to render when no error has occurred. */
  children: React.ReactNode;
  /** Optional custom fallback UI to display on error (default: built-in error card). */
  fallback?: React.ReactNode;
}

/** Internal error state tracked by the boundary. */
interface State {
  /** Whether an error has been caught. */
  hasError: boolean;
  /** The caught error object, if any. */
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex flex-col items-center justify-center h-full p-6 text-center">
          <div className="text-red-400 text-sm font-medium mb-2">Something went wrong</div>
          <div className="text-xs text-gray-500 mb-4 max-w-md">
            {this.state.error?.message || 'An unexpected error occurred in this view.'}
          </div>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="px-4 py-2 bg-blue-500/20 text-blue-400 text-xs rounded hover:bg-blue-500/30 transition-colors"
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
