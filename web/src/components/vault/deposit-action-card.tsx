"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface DepositActionCardProps {
  icon: ReactNode;
  title: string;
  description: string;
  href?: string;
  disabled?: boolean;
  tone?: "default" | "warning";
  className?: string;
  iconClassName?: string;
}

export function DepositActionCard({
  icon,
  title,
  description,
  href,
  disabled = false,
  tone = "default",
  className: customClassName,
  iconClassName,
}: DepositActionCardProps) {
  const className = cn(
    "flex items-center gap-4 rounded-[14px] border p-4 transition-colors",
    tone === "warning" && "border-warning/20 bg-warning/8 text-warning",
    tone === "default" && "border-gray/10 bg-muted/20 text-foreground",
    disabled && "pointer-events-none opacity-55",
    href && !disabled && tone === "warning" && "hover:bg-warning/12",
    href && !disabled && tone === "default" && "hover:bg-muted/30",
    customClassName,
  );

  const content = (
    <>
      <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-background/50", iconClassName)}>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-foreground">{title}</span>
        <span className="mt-0.5 block text-xs text-gray">{description}</span>
      </span>
    </>
  );

  if (href && !disabled) {
    return (
      <Link href={href} className={className}>
        {content}
      </Link>
    );
  }

  return <div className={className}>{content}</div>;
}
