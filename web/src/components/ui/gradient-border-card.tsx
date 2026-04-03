"use client";

import { useRef, useState, type ReactNode, type MouseEvent } from "react";
import { motion } from "framer-motion";

interface GradientBorderCardProps {
  children: ReactNode;
  className?: string;
  innerClassName?: string;
  hoverGlow?: string;
  /** Step number shown in top-right corner */
  step?: string;
}

/**
 * Aura-style card with gradient border that intensifies on hover.
 * Inner area has dark bg, border transitions from subtle to vivid brand colors.
 */
export function GradientBorderCard({
  children,
  className = "",
  innerClassName = "",
  hoverGlow = "rgba(20, 241, 149, 0.15)",
  step,
}: GradientBorderCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [isHovered, setIsHovered] = useState(false);

  const handleMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    setMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  return (
    <motion.div
      ref={ref}
      className={`gradient-border-card ${className}`}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      initial={{ opacity: 0, y: 50, rotateX: 15, scale: 0.95 }}
      whileInView={{ opacity: 1, y: 0, rotateX: 0, scale: 1 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.7, ease: [0.2, 0.8, 0.2, 1] }}
      style={{ perspective: 1000, transformStyle: "preserve-3d" }}
    >
      <div className={`card-inner p-6 sm:p-8 h-full ${innerClassName}`}>
        {/* Mouse-tracking internal glow */}
        <div
          className="pointer-events-none absolute inset-0 rounded-[15px] transition-opacity duration-300"
          style={{
            opacity: isHovered ? 1 : 0,
            background: `radial-gradient(400px circle at ${mousePos.x}px ${mousePos.y}px, ${hoverGlow}, transparent 60%)`,
          }}
        />

        {/* Step number */}
        {step && (
          <span className="absolute top-4 right-4 font-mono text-xs text-gray/30 group-hover:text-privacy/40 transition-colors z-10">
            {step}
          </span>
        )}

        {/* Content */}
        <div className="relative z-10 h-full">{children}</div>
      </div>
    </motion.div>
  );
}
