"use client";

import { Component, type ReactNode } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex flex-col items-center justify-center py-12 space-y-6">
          <div className="flex justify-center">
            <div className="rounded-full bg-destructive/20 p-3">
              <AlertCircle className="h-12 w-12 text-destructive" />
            </div>
          </div>

          <div className="text-center space-y-2">
            <h3 className="text-xl font-semibold">Something went wrong</h3>
            <p className="text-sm text-muted-foreground max-w-md">
              An unexpected error occurred. Please try again.
            </p>
            {this.state.error && (
              <p className="text-xs text-muted-foreground font-mono bg-muted p-2 rounded mt-2">
                {this.state.error.message}
              </p>
            )}
          </div>

          <button
            onClick={this.handleReset}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-lg font-medium",
              "bg-primary text-primary-foreground",
              "hover:opacity-90 transition-opacity",
              "focus:outline-none focus:ring-2 focus:ring-ring"
            )}
          >
            <RefreshCw className="h-4 w-4" />
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
