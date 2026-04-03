"use client";

import { Suspense, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Key, Shield } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

function ClaimRedirect() {
  const router = useRouter();
  // Read from hash fragment (#note=) only — never sent to server
  const [noteParam, setNoteParam] = useState<string | null>(null);

  useEffect(() => {
    const hash = window.location.hash;
    if (hash.includes("note=")) {
      const match = hash.match(/note=([^&#]+)/);
      if (match) {
        setNoteParam(decodeURIComponent(match[1]));
        // Clear hash from URL to prevent leaking via browser history
        window.history.replaceState(null, "", window.location.pathname);
      }
    }
  }, []);

  // If note param present, redirect to Pay with the phrase in hash
  useEffect(() => {
    if (noteParam) {
      router.replace(`/vault/pay#note=${encodeURIComponent(noteParam)}`);
    }
  }, [noteParam, router]);

  const [phrase, setPhrase] = useState("");

  const handleGo = () => {
    if (phrase.trim().length >= 8) {
      router.push(`/vault/pay#note=${encodeURIComponent(phrase.trim())}`);
    }
  };

  // If redirecting, show spinner
  if (noteParam) {
    return (
      <main className="min-h-screen bg-background hacker-bg noise-overlay flex flex-col items-center justify-center p-4">
        <div className="w-16 h-16 rounded-full border-4 border-gray/15 border-t-purple animate-spin" />
        <p className="text-body2 text-gray mt-4">Redirecting to Pay...</p>
      </main>
    );
  }

  // No param: show simple phrase input
  return (
    <main className="min-h-screen bg-background hacker-bg noise-overlay flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-[480px] mb-4 flex items-center justify-between relative z-10">
        <Link
          href="/vault"
          className="inline-flex items-center gap-2 text-body2 text-gray hover:text-gray-light transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Vault
        </Link>
      </div>

      <div
        className={cn(
          "bg-card border border-solid border-gray/30 p-6",
          "w-[480px] max-w-[calc(100vw-32px)] rounded-[16px]",
          "glow-border cyber-corners relative z-10"
        )}
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-[10px] bg-privacy/10">
            <Shield className="w-5 h-5 text-privacy" />
          </div>
          <div>
            <h1 className="text-heading6 text-foreground">Claim zkBTC</h1>
            <p className="text-caption text-gray">
              Enter your secret phrase to claim your note
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-body2 text-gray-light pl-2 mb-2 block">
              Secret Phrase
            </label>
            <div className="relative">
              <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray" />
              <input
                type="text"
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleGo(); }}
                placeholder="Enter your secret phrase..."
                className={cn(
                  "w-full p-3 pl-10 bg-muted border border-gray/15 rounded-[12px]",
                  "text-body2 font-mono text-foreground placeholder:text-gray",
                  "outline-none focus:border-privacy/40 transition-colors"
                )}
              />
            </div>
          </div>

          <button
            onClick={handleGo}
            disabled={phrase.trim().length < 8}
            className="btn-primary w-full"
          >
            <Key className="w-5 h-5" />
            Claim Note
          </button>
        </div>
      </div>
    </main>
  );
}

export default function ClaimPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-background hacker-bg noise-overlay flex flex-col items-center justify-center p-4">
          <div className="w-16 h-16 rounded-full border-4 border-gray/15 border-t-purple animate-spin" />
        </main>
      }
    >
      <ClaimRedirect />
    </Suspense>
  );
}
