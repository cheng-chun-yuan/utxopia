"use client";

import { forwardRef, ButtonHTMLAttributes } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";

type ButtonVariant = "primary" | "secondary" | "tertiary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
  loading?: boolean;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary: cn(
    "bg-privacy hover:bg-privacy/80 text-background",
    "disabled:bg-gray/30 disabled:text-gray"
  ),
  secondary: cn(
    "bg-muted hover:bg-muted/80 border border-gray/30",
    "text-foreground disabled:text-gray"
  ),
  tertiary: cn(
    "bg-transparent hover:bg-gray/10 text-gray-light",
    "border border-gray/20 hover:border-gray/30"
  ),
  ghost: cn(
    "bg-transparent hover:bg-gray/10 text-gray-light"
  ),
  danger: cn(
    "bg-red-500/10 hover:bg-red-500/20 text-red-400",
    "border border-red-500/20"
  ),
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5 text-caption gap-1.5",
  md: "px-4 py-2 text-body2 gap-2",
  lg: "px-6 py-3 text-body1 gap-2",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = "primary",
      size = "md",
      asChild = false,
      loading = false,
      disabled,
      children,
      ...props
    },
    ref
  ) => {
    const Comp = asChild ? Slot : "button";

    return (
      <Comp
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center rounded-[10px]",
          "font-medium transition-colors",
          "focus-visible:outline-none focus-visible:ring-2",
          "focus-visible:ring-privacy focus-visible:ring-offset-2",
          "focus-visible:ring-offset-background",
          "disabled:cursor-not-allowed disabled:opacity-60",
          variantStyles[variant],
          sizeStyles[size],
          className
        )}
        disabled={disabled || loading}
        aria-disabled={disabled || loading}
        {...props}
      >
        {children}
      </Comp>
    );
  }
);

Button.displayName = "Button";
