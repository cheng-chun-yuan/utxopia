"use client";

import { useMemo } from "react";

interface Star {
  top: string;
  left: string;
  size: number;
  delay: string;
  color: string;
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
      "rgba(20, 241, 149, 0.8)",  // privacy green
      "rgba(247, 147, 26, 0.7)",  // btc orange
      "rgba(153, 69, 255, 0.7)",  // sol purple
      "rgba(20, 241, 149, 0.6)",  // green (lighter)
    ];
    return Array.from({ length: count }, (_, i) => ({
      top: `${5 + Math.random() * 85}%`,
      left: `${5 + Math.random() * 90}%`,
      size: 1.5 + Math.random() * 2.5,
      delay: `${(i * 1.2).toFixed(1)}s`,
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
            boxShadow: `0 0 ${star.size * 4}px ${star.color}`,
            animationDelay: star.delay,
            animationDuration: `${3 + Math.random() * 3}s`,
          }}
        />
      ))}
    </div>
  );
}
