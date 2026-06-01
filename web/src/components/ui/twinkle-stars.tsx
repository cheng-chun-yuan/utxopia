"use client";

import { useMemo } from "react";

interface Star {
  top: string;
  left: string;
  size: number;
  delay: string;
  duration: string;
  color: string;
}

function seededUnit(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Decorative twinkling stars scattered across a container.
 * Uses CSS animation (no JS per-frame).
 */
export function TwinkleStars({
  count = 8,
  className = "",
}: {
  count?: number;
  className?: string;
}) {
  const stars = useMemo<Star[]>(() => {
    const colors = [
      "rgba(20, 241, 149, 0.4)",  // privacy green
      "rgba(247, 147, 26, 0.35)", // btc orange
      "rgba(153, 69, 255, 0.35)", // sol purple
      "rgba(20, 241, 149, 0.3)",  // green (lighter)
    ];
    return Array.from({ length: count }, (_, i) => ({
      top: `${5 + seededUnit(i + 1) * 85}%`,
      left: `${5 + seededUnit(i + 17) * 90}%`,
      size: 1.5 + seededUnit(i + 33) * 2.5,
      delay: `${(i * 1.2).toFixed(1)}s`,
      duration: `${3 + seededUnit(i + 49) * 3}s`,
      color: colors[i % colors.length],
    }));
  }, [count]);

  return (
    <div className={`absolute inset-0 pointer-events-none overflow-hidden ${className}`}>
      {stars.map((star, i) => (
        <div
          key={i}
          className="twinkle-star"
          style={{
            top: star.top,
            left: star.left,
            width: `${star.size}px`,
            height: `${star.size}px`,
            backgroundColor: star.color,
            boxShadow: `0 0 ${star.size * 2}px ${star.color}`,
            animationDelay: star.delay,
            animationDuration: star.duration,
          }}
        />
      ))}
    </div>
  );
}
