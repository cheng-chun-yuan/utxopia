"use client";

import { forwardRef, InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type InputVariant = "default" | "privacy" | "btc" | "sol";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  variant?: InputVariant;
  error?: boolean;
  errorMessage?: string;
}

const variantFocusStyles: Record<InputVariant, string> = {
  default: "focus:border-gray/50",
  privacy: "focus:border-privacy/40",
  btc: "focus:border-btc/40",
  sol: "focus:border-sol/40",
};

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      className,
      variant = "default",
      error = false,
      errorMessage,
      id,
      "aria-describedby": ariaDescribedBy,
      ...props
    },
    ref
  ) => {
    const errorId = errorMessage ? `${id}-error` : undefined;
    const describedBy = [ariaDescribedBy, errorId].filter(Boolean).join(" ") || undefined;

    return (
      <div className="w-full">
        <input
          ref={ref}
          id={id}
          className={cn(
            "w-full p-3 bg-muted border rounded-[12px]",
            "text-body2 font-mono text-foreground placeholder:text-gray",
            "outline-none transition-colors",
            "focus-visible:ring-2 focus-visible:ring-offset-2",
            "focus-visible:ring-offset-background",
            error
              ? "border-red-500/50 focus-visible:ring-red-500/30"
              : cn("border-gray/15", variantFocusStyles[variant]),
            variant === "privacy" && "focus-visible:ring-privacy/30",
            variant === "btc" && "focus-visible:ring-btc/30",
            variant === "sol" && "focus-visible:ring-sol/30",
            variant === "default" && "focus-visible:ring-gray/30",
            className
          )}
          aria-invalid={error}
          aria-describedby={describedBy}
          {...props}
        />
        {errorMessage && (
          <p
            id={errorId}
            className="mt-1.5 text-caption text-red-400 pl-2"
            role="alert"
          >
            {errorMessage}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = "Input";
