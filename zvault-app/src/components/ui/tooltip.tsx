"use client";

import { ReactNode, useState } from "react";
import { cn } from "@/lib/utils";
import { HelpCircle } from "lucide-react";

interface TooltipProps {
  content: string;
  children?: ReactNode;
  className?: string;
}

export function Tooltip({ content, children, className }: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);

  return (
    <span
      className={cn("relative inline-flex items-center cursor-help", className)}
      onMouseEnter={() => setIsVisible(true)}
      onMouseLeave={() => setIsVisible(false)}
      onFocus={() => setIsVisible(true)}
      onBlur={() => setIsVisible(false)}
      tabIndex={0}
      role="button"
      aria-describedby={isVisible ? "tooltip" : undefined}
    >
      {children || (
        <HelpCircle className="w-3.5 h-3.5 text-gray hover:text-gray-light transition-colors" />
      )}
      {isVisible && (
        <span
          id="tooltip"
          role="tooltip"
          className={cn(
            "absolute z-50 px-3 py-2 text-caption",
            "bg-card border border-gray/30 rounded-lg shadow-lg",
            "text-gray-light max-w-[200px] text-center",
            "bottom-full left-1/2 -translate-x-1/2 mb-2",
            "animate-in fade-in-0 zoom-in-95 duration-150"
          )}
        >
          {content}
          <span className="absolute top-full left-1/2 -translate-x-1/2 -mt-px border-4 border-transparent border-t-gray/30" />
        </span>
      )}
    </span>
  );
}

interface TooltipTextProps {
  text: string;
  tooltip: string;
  className?: string;
}

export function TooltipText({ text, tooltip, className }: TooltipTextProps) {
  const [isVisible, setIsVisible] = useState(false);

  return (
    <span
      className={cn(
        "relative inline underline decoration-dotted decoration-gray/50 cursor-help",
        className
      )}
      onMouseEnter={() => setIsVisible(true)}
      onMouseLeave={() => setIsVisible(false)}
      onFocus={() => setIsVisible(true)}
      onBlur={() => setIsVisible(false)}
      tabIndex={0}
      role="button"
      aria-describedby={isVisible ? "tooltip-text" : undefined}
    >
      {text}
      {isVisible && (
        <span
          id="tooltip-text"
          role="tooltip"
          className={cn(
            "absolute z-50 px-3 py-2 text-caption",
            "bg-card border border-gray/30 rounded-lg shadow-lg",
            "text-gray-light max-w-[220px]",
            "bottom-full left-1/2 -translate-x-1/2 mb-2",
            "whitespace-normal text-center",
            "animate-in fade-in-0 zoom-in-95 duration-150"
          )}
        >
          {tooltip}
          <span className="absolute top-full left-1/2 -translate-x-1/2 -mt-px border-4 border-transparent border-t-gray/30" />
        </span>
      )}
    </span>
  );
}
