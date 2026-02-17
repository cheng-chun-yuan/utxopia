"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { ArrowLeft, Shield } from "lucide-react";
import { cn } from "@/lib/utils";
import { ManualVerify } from "@/components/btc-widget/manual-verify";

export default function ProvePage() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <main className="min-h-screen bg-background hacker-bg noise-overlay flex flex-col items-center justify-center p-4">
        <div className="w-16 h-16 rounded-full border-4 border-gray/15 border-t-privacy animate-spin" />
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background hacker-bg noise-overlay hacker-grid scan-line flex flex-col items-center justify-center p-4">
      {/* Header */}
      <div className="w-full max-w-[480px] mb-4 flex items-center justify-between relative z-10">
        <Link
          href="/bridge"
          className="inline-flex items-center gap-2 text-body2 text-gray hover:text-gray-light transition-colors hover-glow"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Bridge
        </Link>
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-privacy/10 border border-privacy/20 neon-border-pulse">
          <Shield className="w-3 h-3 text-privacy privacy-glow" />
          <span className="text-caption text-privacy neon-privacy">SPV Verify</span>
        </div>
      </div>

      {/* Widget */}
      <div
        className={cn(
          "bg-card border border-solid border-gray/30 p-4",
          "w-[480px] max-w-[calc(100vw-32px)] rounded-[16px]",
          "glow-border cyber-corners relative z-10 crt-scanlines"
        )}
      >
        <ManualVerify />
      </div>
    </main>
  );
}
