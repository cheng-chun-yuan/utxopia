"use client";

import { type ReactNode } from "react";

/**
 * Animated shimmer/gradient sweep over text.
 * Creates an eye-catching moving gradient highlight.
 */
export function TextShimmer({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={`text-shimmer ${className}`}>
      {children}
    </span>
  );
}
