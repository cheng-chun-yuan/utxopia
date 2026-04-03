"use client";

import { Loader2 } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

interface LoadingStateProps {
  message?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizeStyles = {
  sm: { icon: "w-3 h-3", text: "text-caption" },
  md: { icon: "w-4 h-4", text: "text-body2" },
  lg: { icon: "w-6 h-6", text: "text-body1" },
};

export function LoadingState({
  message = "Loading...",
  size = "md",
  className,
}: LoadingStateProps) {
  const styles = sizeStyles[size];

  return (
    <div
      className={cn("flex items-center justify-center gap-2", className)}
      role="status"
      aria-live="polite"
    >
      <Loader2 className={cn(styles.icon, "animate-spin text-gray")} />
      <span className={cn(styles.text, "text-gray")}>{message}</span>
    </div>
  );
}

interface LoadingOverlayProps {
  message?: string;
  className?: string;
}

function PulsingDot({ delay }: { delay: number }) {
  return (
    <motion.div
      className="w-2 h-2 rounded-full bg-privacy"
      animate={{
        scale: [1, 1.4, 1],
        opacity: [0.4, 1, 0.4],
      }}
      transition={{
        duration: 1,
        repeat: Infinity,
        delay,
        ease: "easeInOut",
      }}
    />
  );
}

export function LoadingOverlay({
  message = "Loading...",
  className,
}: LoadingOverlayProps) {
  return (
    <div
      className={cn(
        "absolute inset-0 flex items-center justify-center",
        "bg-background/80 backdrop-blur-sm rounded-[12px] z-10",
        className
      )}
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-3">
        <div className="flex items-center gap-1.5">
          <PulsingDot delay={0} />
          <PulsingDot delay={0.15} />
          <PulsingDot delay={0.3} />
        </div>
        <span className="text-body2 text-gray">{message}</span>
      </div>
    </div>
  );
}
