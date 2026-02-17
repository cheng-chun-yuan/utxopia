"use client";

import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface SpinnerProps {
  className?: string;
  size?: "sm" | "md" | "lg";
}

const sizeMap = {
  sm: "h-4 w-4",
  md: "h-6 w-6",
  lg: "h-8 w-8",
};

export function Spinner({ className, size = "sm" }: SpinnerProps) {
  return (
    <div className="animate-spin">
      <Loader2 className={cn(sizeMap[size], className)} />
    </div>
  );
}
