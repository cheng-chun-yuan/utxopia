"use client";

import { motion } from "framer-motion";

/**
 * Animated floating gradient orbs for hero/section backgrounds.
 * Three orbs map to brand pillars: Privacy Green, Bitcoin Orange, Solana Purple.
 */
export function FloatingOrbs({ className = "" }: { className?: string }) {
  return (
    <div className={`absolute inset-0 overflow-hidden pointer-events-none ${className}`}>
      {/* Privacy Green orb — dominant, top-left */}
      <motion.div
        className="absolute w-[500px] h-[500px] rounded-full opacity-10"
        style={{
          background: "radial-gradient(circle, rgba(20,241,149,0.3) 0%, transparent 70%)",
          filter: "blur(80px)",
          top: "-10%",
          left: "10%",
        }}
        animate={{
          x: [0, 40, -20, 0],
          y: [0, -30, 20, 0],
          scale: [1, 1.1, 0.95, 1],
        }}
        transition={{
          duration: 12,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      />
      {/* Bitcoin Orange orb — center-right */}
      <motion.div
        className="absolute w-[400px] h-[400px] rounded-full opacity-8"
        style={{
          background: "radial-gradient(circle, rgba(247,147,26,0.25) 0%, transparent 70%)",
          filter: "blur(80px)",
          top: "20%",
          right: "5%",
        }}
        animate={{
          x: [0, -30, 20, 0],
          y: [0, 40, -20, 0],
          scale: [1, 0.9, 1.1, 1],
        }}
        transition={{
          duration: 15,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      />
      {/* Solana Purple orb — bottom-center */}
      <motion.div
        className="absolute w-[350px] h-[350px] rounded-full opacity-8"
        style={{
          background: "radial-gradient(circle, rgba(153,69,255,0.25) 0%, transparent 70%)",
          filter: "blur(80px)",
          bottom: "5%",
          left: "40%",
        }}
        animate={{
          x: [0, 25, -35, 0],
          y: [0, -25, 15, 0],
          scale: [1, 1.05, 0.92, 1],
        }}
        transition={{
          duration: 18,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      />
    </div>
  );
}
