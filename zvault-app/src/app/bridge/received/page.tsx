"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Redirect to the unified Notes page (activity) with the claimable tab
 * The received page functionality has been merged into /bridge/activity
 */
export default function ReceivedPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/bridge/activity?tab=claimable");
  }, [router]);

  // Show a brief loading state while redirecting
  return (
    <main className="min-h-screen bg-background hacker-bg noise-overlay flex flex-col items-center justify-center p-4">
      <div className="flex items-center gap-2 text-gray">
        <div className="w-5 h-5 border-2 border-privacy border-t-transparent rounded-full animate-spin" />
        <span className="text-body2">Redirecting to Notes...</span>
      </div>
    </main>
  );
}
