"use client";

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Copy,
  LogIn,
  Wallet,
} from "lucide-react";
import {
  buildGoogleZkLoginUrl,
  clearSuiZkLoginSession,
  consumeSuiZkLoginCallback,
  createSuiZkLoginSession,
  getSuiZkLoginSession,
  type SuiZkLoginSession,
} from "@/lib/sui/client";
import { cn } from "@/lib/utils";

interface BrowserSuiWallet {
  requestPermissions?: () => Promise<void>;
  getAccounts?: () => Promise<string[]>;
}

declare global {
  interface Window {
    suiWallet?: BrowserSuiWallet;
  }
}

export function SuiAuthPanel({ embedded = false }: { embedded?: boolean }) {
  const [address, setAddress] = useState<string | null>(null);
  const [session, setSession] = useState<SuiZkLoginSession | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    setSession(getSuiZkLoginSession());
    let cancelled = false;
    async function run() {
      try {
        const callback = await consumeSuiZkLoginCallback();
        if (cancelled) return;
        if (callback.error) {
          setStatus("error");
          setMessage(callback.error);
          return;
        }
        if (callback.jwt) {
          setAddress(callback.address);
          setStatus(callback.address ? "ready" : "idle");
          setMessage(
            callback.address
              ? "Signed in with Google."
              : "Google sign-in completed, but the salt endpoint is not configured.",
          );
        }
      } catch (error) {
        if (!cancelled) {
          setStatus("error");
          setMessage(error instanceof Error ? error.message : String(error));
        }
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, []);

  async function connectSuiWallet() {
    setStatus("loading");
    setMessage("");
    try {
      const wallet = window.suiWallet;
      if (!wallet?.requestPermissions || !wallet.getAccounts) {
        throw new Error("No Sui wallet extension was found. Use Google sign-in or install a Sui wallet.");
      }
      await wallet.requestPermissions();
      const accounts = await wallet.getAccounts();
      if (!accounts[0]) throw new Error("No Sui account was returned by the wallet.");
      setAddress(accounts[0]);
      setStatus("ready");
      setMessage("Sui wallet connected.");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function startZkLogin() {
    setStatus("loading");
    setMessage("");
    try {
      const nextSession = await createSuiZkLoginSession();
      setSession(nextSession);
      window.location.href = buildGoogleZkLoginUrl(nextSession);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function resetZkLogin() {
    clearSuiZkLoginSession();
    setSession(null);
    setAddress(null);
    setStatus("idle");
    setMessage("");
  }

  return (
    <section className={cn(!embedded && "rounded-[14px] border border-gray/10 bg-muted/10 p-4")}>
      {!embedded && (
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-foreground">Sign in</h2>
          <Status state={status} />
        </div>
      )}

      <div className={cn("space-y-3", !embedded && "mt-4")}>
        <button
          type="button"
          onClick={startZkLogin}
          disabled={status === "loading"}
          className="flex w-full items-center gap-4 rounded-[14px] border border-sui/15 bg-sui/8 p-4 text-left transition-colors hover:border-sui/30 hover:bg-sui/12 disabled:cursor-wait disabled:opacity-60"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-sui/12 text-sui">
            <LogIn className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-sui">
              {status === "loading" ? "Opening Google..." : "Continue with Google"}
            </span>
            <span className="mt-0.5 block text-xs text-gray">zkLogin</span>
          </span>
        </button>

        <button
          type="button"
          onClick={connectSuiWallet}
          disabled={status === "loading"}
          className="flex w-full items-center gap-4 rounded-[14px] border border-gray/15 bg-muted/20 p-4 text-left transition-colors hover:border-sui/25 hover:bg-muted/30 disabled:cursor-wait disabled:opacity-60"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-background/55 text-foreground">
            <Wallet className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-foreground">
              Connect Sui wallet
            </span>
            <span className="mt-0.5 block text-xs text-gray">Browser wallet</span>
          </span>
        </button>

        {address && (
          <div className="flex items-center justify-between gap-3 rounded-[12px] border border-sui/15 bg-sui/5 px-3 py-2">
            <span className="min-w-0 truncate font-mono text-xs text-foreground/85">{address}</span>
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(address)}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-gray/10 px-2 py-1 text-[11px] text-gray transition-colors hover:text-foreground"
            >
              <Copy className="h-3 w-3" />
              Copy
            </button>
          </div>
        )}

        {(message || session) && (
          <div className="flex items-start justify-between gap-3">
            {message && (
              <p className={cn("text-xs leading-5", status === "error" ? "text-error" : "text-gray")}>
                {message}
              </p>
            )}
            {session && (
              <button
                type="button"
                onClick={resetZkLogin}
                className="ml-auto shrink-0 text-xs font-semibold text-gray transition-colors hover:text-foreground"
              >
                Reset
              </button>
            )}
          </div>
        )}
      </div>

    </section>
  );
}

function Status({ state }: { state: "idle" | "loading" | "ready" | "error" }) {
  const ok = state === "ready";
  const error = state === "error";
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em]",
        ok && "border-sui/20 bg-sui/10 text-sui",
        error && "border-error/20 bg-error/10 text-error",
        !ok && !error && "border-gray/15 bg-muted/20 text-gray",
      )}
    >
      {ok ? <CheckCircle2 className="h-3 w-3" /> : <CircleAlert className="h-3 w-3" />}
      {state}
    </span>
  );
}
