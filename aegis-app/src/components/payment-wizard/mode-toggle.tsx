"use client";

import { cn } from "@/lib/utils";
import { Zap, SlidersHorizontal } from "lucide-react";

interface ModeToggleProps {
  mode: "lite" | "pro";
  onChange: (mode: "lite" | "pro") => void;
}

export function ModeToggle({ mode, onChange }: ModeToggleProps) {
  return (
    <div className="flex items-center justify-center mb-5" role="radiogroup" aria-label="Flow mode">
      <div className="inline-flex items-center rounded-full bg-muted/50 border border-gray/15 p-0.5 gap-0.5">
        <button
          role="radio"
          aria-checked={mode === "lite"}
          onClick={() => onChange("lite")}
          className={cn(
            "flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-medium",
            "transition-all duration-200 ease-out cursor-pointer",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-privacy/50 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            "min-h-[36px]", // touch target
            mode === "lite"
              ? "bg-privacy/12 text-privacy shadow-sm"
              : "text-gray/50 hover:text-gray/70 hover:bg-white/[0.03]",
          )}
        >
          <Zap className="w-3.5 h-3.5" />
          Lite
        </button>
        <button
          role="radio"
          aria-checked={mode === "pro"}
          onClick={() => onChange("pro")}
          className={cn(
            "flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-medium",
            "transition-all duration-200 ease-out cursor-pointer",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple/50 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            "min-h-[36px]", // touch target
            mode === "pro"
              ? "bg-purple/12 text-purple-400 shadow-sm"
              : "text-gray/50 hover:text-gray/70 hover:bg-white/[0.03]",
          )}
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
          Pro
        </button>
      </div>
    </div>
  );
}
