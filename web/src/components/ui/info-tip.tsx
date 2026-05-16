"use client";

import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Small expandable hint — collapses a paragraph of explainer text behind
 * an `i` icon so settings rows can stay compact. Uses `<details>` so the
 * open/close state is native (works on mobile, no JS, no portal).
 *
 * Stop click propagation on the summary because most call sites nest this
 * inside a clickable card.
 */
export function InfoTip({
  children,
  className,
  label = "More info",
}: {
  children: React.ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <details
      className={cn("group inline-block align-middle", className)}
      onClick={(e) => e.stopPropagation()}
    >
      <summary
        aria-label={label}
        className={cn(
          "list-none cursor-pointer inline-flex items-center justify-center",
          "w-4 h-4 rounded-full text-muted-foreground/60",
          "hover:text-foreground hover:bg-muted/40 transition-colors",
          "group-open:text-privacy group-open:bg-privacy/10",
        )}
      >
        <Info className="w-3 h-3" />
      </summary>
      <div className="mt-2 rounded-lg border border-gray/10 bg-muted/10 px-3 py-2 text-xs text-muted-foreground leading-relaxed">
        {children}
      </div>
    </details>
  );
}
